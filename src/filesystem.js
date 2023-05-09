import { readFile, watch, readdir } from "fs/promises";
import { logger } from "./logging.js";
import { generate_name } from './format.js';

const updateTasks = [];

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

async function initialize_secrets(namespace, folder_path) {
  const files =  (await readdir(folder_path, {withFileTypes: true}))
    .filter(e => e.isFile())
    .map(e => e.name)
  for (const filename of files) {
    const path = folder_path + "/" + filename;
    const secret_name = generate_name(namespace, folder_path, filename)
    logger.info("Init secret %s", secret_name)
    const buffer = await readFile(path)
    const content = buffer.toString("base64")
    updateTasks.push({ namespace, secret_name, folder_path, filename, content })
  }
}

async function configure(namespace, folder_path) {
  logger.info("Configuring namespace %s, using folder %s", namespace, folder_path)

  await initialize_secrets(namespace, folder_path);

  const watcher = watch(folder_path)
  for await (const event of watcher) {
    const { eventType, filename } = event
    await file_event_handler(namespace, folder_path, eventType, filename)
  }
}

export { configure, updateTasks };
