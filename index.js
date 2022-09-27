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
    .replace(" ", "_")
    .replace("/", "_")
    .replace(".", "")
    .replace(/^_+|_+$/gm,'');
  const part2 = filename.trim()
    .replace(" ", "_")
    .replace("/", "_")
    .replace(".", "_")
    .replace(/^_+|_+$/gm,'');
  const name = namespace + "_" + part1 + "_" + part2
  return name
}

const secrets_folder = config.get("secret_folder")

const docker = new Docker(config.get("docker"));

const fileTouchDelay = config.get("fileTouchDelay")

const secrets_register = {}

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
  const existingSecret = secrets.find(secret => secret.Spec.Name.includes(secret_name))
  const buffer = await readFile(path)
  const content = buffer.toString("base64")
  const versionLabelName = "updated.swarm." + namespace
  if (existingSecret === undefined) {
    const labels = {};
    labels[versionLabelName] = "0"
    logger.info("%s does not exist, creating from %s", secret_name, path)
    await docker.createSecret({Name: secret_name, Labels: labels, Data: content})
  } else {
    logger.info("%s exists, updating from %s", secret_name, path)
    const labels = {};
    const secret = docker.getSecret(existingSecret.ID)
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
      .map(resp => updateServiceSecret(existingSecret, newSecretId, resp, labelVersion))
    await Promise.all(updatePromises)
    const newSecret = docker.getSecret(newSecretId)

    try {
      await secret.remove()
    } catch (err) {
      console.error("Could not remove secret", secret.Name, err)
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
    dockerSecretsUpdate(namespace, secret_name, folder_path, filename)
  }
}

async function scheduleTouchFiles(folder_path) {
  const files = await readdir(folder_path)
  logger.info("Folder %s contains the following files: %s", folder_path, files)
  await Promise.all(files.map(async filename => {
    logger.info("Waiting %d ms to touch file %s/%s", fileTouchDelay, folder_path, filename)
    await later(fileTouchDelay)
    logger.info("Touching file %s/%s", folder_path, filename)
    const now = new Date()
    await utimes(folder_path + "/" + filename, now, now)
  }))
}

async function configure(namespace, folder_path) {
  logger.info("Configuring namespace %s, using folder %s", namespace, folder_path)
  const watcher = watch(folder_path)
  for await (const event of watcher) {
    const { eventType, filename } = event
    await file_event_handler(secrets_register, namespace, folder_path, eventType, filename)
  }
}

logger.info("Launching Swarm Updated")

Promise.all(Object.keys(secrets_folder).map(
  async namespace => await configure(
    namespace,
    secrets_folder[namespace]
  )
))
  .catch(err => console.error("Could not launch configuration", err))

logger.info("Scheduling files touch")

Promise.all(Object.keys(secrets_folder).map(
  async namespace => await scheduleTouchFiles(secrets_folder[namespace])
))
  .catch(err => console.error("Could not schedule touch files", err))