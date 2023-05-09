import config from "config";

import docker from "./docker.js";
import { updateTasks } from "./filesystem.js";
import { logger } from './logging.js';


function secret_updates() {
  const updates = {};
  for (const update of updateTasks) {
    updates[update.secret_name] = update;
  }
  return updates;
}

function isInt(value) {
  return !isNaN(value) &&
         parseInt(Number(value)) == value &&
         !isNaN(parseInt(value, 10));
}

async function outdated_secrets(update) {
  const resp = await docker.listSecrets()
  const secrets = resp.filter(secret => secret.Spec.Name.split(".")[0] === update.secret_name);
  const versions = secrets
    .map(secret => secret.Spec.Name.split("."))
    .map(l => l.length > 1 && isInt(l[1])? parseInt(l[1]) : 0)
  const new_version = (Math.max(...versions) + 1) % config.get("max_versions");
  return {
    outdated: secrets,
    new_version: new_version,
  }
}

async function secret_update_map(secret_updates) {
  const update_map = {};
  for (const key of Object.keys(secret_updates)) {
    const update = secret_updates[key];
    const outdated = await outdated_secrets(update);
    update_map[key] = {
      update: update,
      outdated: outdated.outdated,
      new_version: outdated.new_version,
    }
  }
  return update_map;
}

async function create_new_secrets(update_map) {
  for (const key of Object.keys(update_map)) {
    const version = update_map[key].new_version;
    const name = key + "." + version;
    logger.info("Creating new secret %s with version %s", key, version)
    const existing_secrets = await docker.listSecrets();
    if (name in existing_secrets) {
    } else {
      const new_secret = await docker.createSecret({
        Name: name,
        Data: update_map[key].update.content,
      });
      update_map[key].new_secret = new_secret;
    }
  }
}

async function remove_outdated_secrets(outdated_secrets) {
  for (const config of outdated_secrets) {
    logger.info("Removing outdated secret %s", config.Spec.Name);
    const secret = await docker.getSecret(config.ID);
    await secret.remove();
  }
}

export {
  secret_updates,
  secret_update_map,
  create_new_secrets,
  remove_outdated_secrets,
}