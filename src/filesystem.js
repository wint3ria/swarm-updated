import config from 'config';

import { readFile, readdir } from "fs/promises";
import { watch } from "chokidar";
import md5 from "md5";

import { logger } from "./logging.js";
import { generate_name } from './format.js';
import { later } from './utils.js'

const updateTasks = [];
const md5sums = {};

async function file_event_handler(namespace, folder_path, eventType, filename) {
  logger.info("Event %s happening on file %s", eventType, filename)
  const secret_name = generate_name(namespace, folder_path, filename);
  if (eventType === "change") {
    logger.info("Secret %s changed, scheduling docker operations", secret_name)
    const path = folder_path + "/" + filename;
    const buffer = await readFile(path)
    const content = buffer.toString("base64")
    updateTasks.push({namespace, secret_name, folder_path, filename, content})
    return;
  }
  if (eventType === "rename") {
    logger.error(
      "Secret file %s in folder %s for namespace %s associated with secret %s was renamed, this is undefined behavior",
      filename, folder_path, namespace, secret_name
    )
    return;
  }
}

async function initialize_secrets_with_md5(namespace, folder_path) {
  const files =  (await readdir(folder_path, {withFileTypes: true}))
    .filter(e => e.isFile())
    .map(e => e.name)
  for (const filename of files) {
    const path = folder_path + "/" + filename;
    const secret_name = generate_name(namespace, folder_path, filename)
    logger.debug("Checking secret %s", secret_name)
    const buffer = await readFile(path)
    const content = buffer.toString("base64")
    const md5sum = md5(content)
    if (md5sums[secret_name] !== md5sum) {
      logger.info("Secret %s did not match or was missing, updating secret", secret_name)
      md5sums[secret_name] = md5sum
      updateTasks.push({ namespace, secret_name, folder_path, filename, content })
    } else {
      logger.debug("Secret %s md5 matched, no update", secret_name)
    }
  }
}

async function configure_md5_checks(namespace, folder_path) {
  logger.info("Configuring namespace %s, using folder %s", namespace, folder_path)

  while (true) {
    await initialize_secrets_with_md5(namespace, folder_path);
    await later(config.get("md5_check_interval"));
  }
}

async function configure_watcher(namespace, folder_path) {
  logger.info("Configuring namespace %s, using folder %s", namespace, folder_path)

  const watcher = watch(folder_path, { persistent: true})

  watcher.on("all", async (event, path) => {
    logger.debug("Event %s happening on file %s", event, path)
  });

  for await (const event of watcher) {
    const { eventType, filename } = event
    await initialize_secrets_with_md5(namespace, folder_path, eventType, filename)
  }
}


export { configure_md5_checks, configure_watcher, updateTasks };
