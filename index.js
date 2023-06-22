import config from 'config';

import { logger } from './src/logging.js';
import { later } from './src/utils.js';
import { configure_md5_checks as configure } from './src/filesystem.js';
import { update_services } from './src/services.js';
import { updateTasks } from './src/filesystem.js';
import {
  secret_updates,
  secret_update_map,
  create_new_secrets,
  remove_outdated_secrets
} from './src/secrets.js';

const secrets_folder = config.get("secret_folder")
const update_detection_interval = config.get("update_detection_interval")
const update_interval = config.get("update_interval")
const secret_wait_time = config.get("secret_wait_time")
const service_wait_time = config.get("service_wait_time")

let last_update = new Date();

logger.info("Launching Swarm Updated")

async function update_iteration() {

  const updates = secret_updates();
  const first_detection_interval = new Date() - last_update;

  if (Object.keys(updates).length === 0) {
    logger.debug("No updates detected");
    last_update = new Date();
    setTimeout(update_iteration, update_detection_interval);
    return;
  } else if (first_detection_interval < update_interval) {
    logger.debug(
      "Update detected but not enough time has passed since the first detection of this batch %dms/%dms [%d\%]",
      first_detection_interval,
      update_interval,
      Math.round(first_detection_interval / update_interval * 100)
    );
    setTimeout(update_iteration, update_detection_interval);
    return;
  }
  const update_map = await secret_update_map(updates);
  logger.info("Creating new secrets");
  await create_new_secrets(update_map);

  logger.info("Created new secrets, waiting %dms for Docker to converge", secret_wait_time);
  await later(secret_wait_time);

  logger.info("Updating services");
  await update_services(update_map);

  logger.info("Updated services, waiting %dms for Docker to converge", service_wait_time);
  await later(service_wait_time);

  logger.info("Removing outdated secrets");
  for (const [secret_name, update] of Object.entries(update_map)) {
    await remove_outdated_secrets(update.outdated);
  }

  updateTasks.length = 0;

  setTimeout(update_iteration, update_interval);
}

setTimeout(update_iteration, 500); // just a bit later, so that we can schedule the filesystem config

const promises = [];
for (const [namespace, folder_path] of Object.entries(secrets_folder)) {
  promises.push(configure(namespace, folder_path));
}
await Promise.all(promises);