import { readFile, watch, readdir, utimes } from "fs/promises";
import config from 'config';
import Docker from 'dockerode';
import { createLogger, config as wconfig, transports, format } from 'winston';

const { combine } = format;
const logger = createLogger({
  levels: wconfig.npm.levels,
  transports: [
    ...(config.has("logging.transport.console") ?
          config.get("logging.transport.console").map(cfg => new transports.Console(cfg))
        : []
    ),
    ...(config.has("logging.transport.File") ?
          config.get("logging.transport.file").map(cfg => new transports.File(cfg))
        : []
    ),
  ],
  exitOnError: config.get("logging.exitOnError"),
  format: combine(
    ...config.get("logging.formatters").map(key => format[key]())
  )
})

function later(delay) {
  return new Promise(function(resolve) {
      setTimeout(resolve, delay);
  });
}

function generate_name(namespace, folder_path, filename) {
  const part1 = folder_path.trim()
    .replaceAll(" ", "_")
    .replaceAll("/", "_")
    .replaceAll(".", "_")
    .replaceAll(/^_+|_+$/gm,'');
  const part2 = filename.trim()
    .replaceAll(" ", "_")
    .replaceAll("/", "_")
    .replaceAll(".", "_")
    .replaceAll(/^_+|_+$/gm,'');
  const name = namespace + "_" + part1 + "_" + part2
  return name
}

const secrets_folder = config.get("secret_folder")

const docker = new Docker(config.get("docker"));

const updateInterval = config.get("updateInterval")

const secrets_register = {}

const updateTasks = []

async function updateServiceSecret(oldSecret, newSecretId, serviceResponse, version) {
  const oldSecretTarget = serviceResponse.Spec.TaskTemplate.ContainerSpec.Secrets.find(
    s => s.SecretID === oldSecret.ID
  )
  const oldSecretName = oldSecretTarget.SecretName
  const newSecretName = oldSecretName.split(".")[0] + "." + version
  const newSecrets = [
    ...serviceResponse.Spec.TaskTemplate.ContainerSpec.Secrets.filter(
      s => s.SecretID !== oldSecret.ID
    ),
    {
      File: oldSecretTarget.File,
      SecretID: newSecretId,
      SecretName: newSecretName
    }
  ]
  const service = docker.getService(serviceResponse.ID)
  try {
    logger.info(
      "Updating service %s using secret %s to its new version %s",
      serviceResponse.Spec.Name,
      oldSecretName,
      newSecretName
    )
    await service.update("auth", {
      ...serviceResponse.Spec,
      version: serviceResponse.Version.Index,
      TaskTemplate: {
        ...serviceResponse.Spec.TaskTemplate,
        ContainerSpec: {
          ...serviceResponse.Spec.TaskTemplate.ContainerSpec,
          Secrets: newSecrets
        }
      }
    })
  } catch (err) {
    console.error("Could not update service", serviceResponse.Spec.Name, err)
  }
}

async function dockerSecretsUpdate (namespace, secret_name, folder_path, filename) {
  const secrets = await docker.listSecrets()
  const path = folder_path + "/" + filename
  const buffer = await readFile(path)
  const content = buffer.toString("base64")
  const versionLabelName = "updated.swarm." + namespace
  const existingSecrets = secrets.filter(secret => secret.Spec.Name.includes(secret_name))
  existingSecrets.sort((a, b) => a.Spec.Name < b.Spec.Name ? -1 : 1);
  const existingSecret = existingSecrets.at(-1);
  const staleSecrets = await Promise.all(existingSecrets.slice(0, -1).map(async s => await docker.getSecret(s.ID)));
  if (existingSecret === undefined) {
    const labels = {};
    labels[versionLabelName] = "0"
    logger.info("%s does not exist, creating from %s", secret_name, path)
    await docker.createSecret({Name: secret_name, Labels: labels, Data: content})
  } else {
    logger.info("%s exists, updating from %s", secret_name, path)
    const labels = {};
    const secret = await docker.getSecret(existingSecret.ID)
    const oldLabelVersion = existingSecret.Spec.Labels[versionLabelName]
    const labelVersion = String(parseInt(oldLabelVersion) + 1)
    logger.info("Updating secret %s from version %s to version %s", secret_name, oldLabelVersion, labelVersion)
    labels[versionLabelName] = labelVersion
    const config = {Name: secret_name + "." + labelVersion, Labels: labels, Data: content}
    const newSecretId = (await docker.createSecret(config)).id
    logger.info("Updating services using old secret %s.%s", secret_name, oldLabelVersion)
    const updatePromises = (await docker.listServices())
      .filter(resp => resp.Spec.TaskTemplate.ContainerSpec.Secrets)
      .filter(resp =>
        resp.Spec.TaskTemplate.ContainerSpec.Secrets.find(s => s.SecretName.includes(secret_name))
      )
      .map(resp =>  updateServiceSecret(existingSecret, newSecretId, resp, labelVersion))
    await Promise.all(updatePromises)
    logger.info("Done updating services using old secret %s.%s", secret_name, oldLabelVersion)
    staleSecrets.push(secret)
  }

  for (let i = 0; i < staleSecrets.length; i++) {
    try {
      logger.info("Removing stale secret: %s", existingSecrets[i].Spec.Name)
      await staleSecrets[i].remove()
    } catch (err) {
      console.error("Could not remove secret: %s", existingSecrets[i].Spec.Name, err)
    }
  }
}

async function file_event_handler(register, namespace, folder_path, eventType, filename) {
  logger.info("Event %s happening on file %s", eventType, filename)
  const secret_name = generate_name(namespace, folder_path, filename);
  const isChange = eventType === "change"
  const alreadyRegistered = secret_name in register
  if (!alreadyRegistered) {
    logger.info("Secret %s first registration, activated: %s", secret_name, isChange)
  }
  if (!isChange) {
    logger.info("Secret deactivation: %s", secret_name)
  }
  const activeOld = register[secret_name]
  const newActive = (activeOld || !alreadyRegistered) && isChange
  if (!newActive) {
    logger.info("Configuration %s deactivated", secret_name)
    return;
  }
  register[secret_name] = newActive
  if (newActive) {
    logger.info("Secret %s is active, performing docker operations", secret_name)
    updateTasks.push({namespace, secret_name, folder_path, filename})
    //await dockerSecretsUpdate(namespace, secret_name, folder_path, filename)
  }
}

async function configure(namespace, folder_path) {
  logger.info("Configuring namespace %s, using folder %s", namespace, folder_path)

  const files =  (await readdir(folder_path, {withFileTypes: true}))
    .filter(e => e.isFile())
    .map(e => e.name)
  for (const filename of files) {
    const secret_name = generate_name(namespace, folder_path, filename)
    updateTasks.push({ namespace, secret_name, folder_path, filename })
  }

  const watcher = watch(folder_path)
  for await (const event of watcher) {
    const { eventType, filename } = event
    await file_event_handler(secrets_register, namespace, folder_path, eventType, filename)
  }
}

async function scheduledUpdate() {
  if (updateTasks.length === 0) {
    logger.info("No updates to perform, rescheduled in %d ms", updateInterval);
    return;
  }
  logger.info("Performing %d update...", updateTasks.length);
  for (const task of updateTasks) {
    const { namespace, secret_name, folder_path, filename } = task
    await dockerSecretsUpdate(namespace, secret_name, folder_path, filename)
  }
  updateTasks.length = 0;
  logger.info("Done updating");
}

logger.info("Launching Swarm Updated")

Promise.all([...Object.keys(secrets_folder).map(
  async namespace => await configure(
    namespace,
    secrets_folder[namespace]
  )
), setInterval(
  scheduledUpdate,
  updateInterval
)])
  .catch(err => console.error("Could not launch configuration", err))
