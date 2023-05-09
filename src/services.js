import docker from "./docker.js";
import { logger } from './logging.js';

export async function update_services(update_map) {

  const outdated_secret_ids = Object.keys(update_map)
    .map(key => update_map[key].outdated.map(s => s.ID))
    .flat()

  const services = await docker.listServices()

  for (const service of services) {
    const service_changed_secret = [];
    if (service.Spec.TaskTemplate.ContainerSpec.Secrets === undefined) {
      logger.debug("No changes for service %s", service.Spec.Name)
      continue;
    }
    for (const secret of service.Spec.TaskTemplate.ContainerSpec.Secrets) {
      if (outdated_secret_ids.includes(secret.SecretID)) {
        const key = secret.SecretName.split(".")[0];
        const updateAction = {
          File: secret.File,
          SecretID: update_map[key].new_secret.id,
          SecretName: update_map[key].update.secret_name + "." + update_map[key].new_version,
        }
        service_changed_secret.push(updateAction);
      }
    }
    if (service_changed_secret.length === 0) {
      logger.debug("No changes for service %s", service.Spec.Name)
      continue;
    }

    const new_secrets = [
      ...service.Spec.TaskTemplate.ContainerSpec.Secrets.filter(
        s => !outdated_secret_ids.includes(s.SecretID)
      ),
      ...service_changed_secret,
    ]

    const service_handler = await docker.getService(service.ID)
    try {
      logger.info(
        "Updating service %s using an outdated secret spec",
        service.Spec.Name,
        {
          previous_secrets: service.Spec.TaskTemplate.ContainerSpec.Secrets.map(s => s.SecretName),
          new_secrets: new_secrets.map(s => s.SecretName),
        }
      )
      await service_handler.update("auth", {
        ...service.Spec,
        version: service.Version.Index,
        TaskTemplate: {
          ...service.Spec.TaskTemplate,
          ContainerSpec: {
            ...service.Spec.TaskTemplate.ContainerSpec,
            Secrets: new_secrets
          }
        }
      })
    } catch (err) {
      logger.error("Could not update service", { secret: service.Spec.Name, err: err })
    }
  }

}