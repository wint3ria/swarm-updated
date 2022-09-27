import { readFile, watch } from "fs/promises";
import config from 'config';
import Docker from 'dockerode';

const secrets_folder = config.get("secret_folder")

const docker = new Docker(config.get("docker"));

const secrets_register = {}

async function updateServiceSecret(oldSecret, newSecretId, serviceResponse, version) {
  const oldSecretTarget = serviceResponse.Spec.TaskTemplate.ContainerSpec.Secrets.find(
    s => s.SecretID === oldSecret.ID
  )
  console.log(oldSecretTarget)
  const newSecrets = [
    ...serviceResponse.Spec.TaskTemplate.ContainerSpec.Secrets.filter(
      s => s.SecretID !== oldSecret.ID
    ),
    {
      File: oldSecretTarget.File,
      SecretID: newSecretId,
      SecretName: oldSecretTarget.SecretName.split(".")[0] + "." + version
    }
  ]
  const service = docker.getService(serviceResponse.ID)

  try {
    console.log("Update service", serviceResponse.Spec.Name, "using outdated secret", oldSecret.Spec.Name)
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
    console.log(secret_name, "does not exist, creating from", path)
    await docker.createSecret({Name: secret_name, Labels: labels, Data: content})
  } else {
    console.log(secret_name, "exists, updating from", path)
    const labels = {};
    const secret = docker.getSecret(existingSecret.ID)
    const labelVersion = String(parseInt(existingSecret.Spec.Labels[versionLabelName]) + 1)
    labels[versionLabelName] = labelVersion
    const config = {Name: secret_name + "." + labelVersion, Labels: labels, Data: content}
    const newSecretId = (await docker.createSecret(config)).id
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

function generate_name(namespace, folder_path, filename) {
  const part1 = folder_path
    .replace("/", "_")
    .replace(".", "")

  const part2 = filename
    .replace("/", "_")
    .replace(".", "_")

  return namespace + "_" + part1 + "_" + part2
}

async function file_event_handler(register, namespace, folder_path, eventType, filename) {
  console.log("Event", eventType, "on file", filename)
  const secret_name = generate_name(namespace, folder_path, filename);
  const isChange = eventType === "change"
  const alreadyRegistered = secret_name in register
  if (!alreadyRegistered) {
    console.log("Configuration", secret_name, "first registration, activated:", isChange)
  }
  if (!isChange) {
    console.log("Configuration", secret_name, "deactivation")
  }
  const activeOld = register[secret_name]
  const newActive = (activeOld || !alreadyRegistered) && isChange
  if (!newActive) {
    console.log("Configuration", secret_name, "deactivated")
    return;
  }
  register[secret_name] = newActive
  if (newActive) {
    console.log("Configuration", secret_name, "is active, performing docker operations")
    dockerSecretsUpdate(namespace, secret_name, folder_path, filename)
  }
}

async function configure(namespace, folder_path) {
  const watcher = watch(folder_path)
  for await (const event of watcher) {
    const { eventType, filename } = event
    await file_event_handler(secrets_register, namespace, folder_path, eventType, filename)
  }
}

Promise.all(Object.keys(secrets_folder).map(
  async namespace => configure(
    namespace,
    secrets_folder[namespace]
  )
))
  .catch(err => console.error("Could not launch configuration", err))