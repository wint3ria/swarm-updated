function generate_name(namespace, folder_path, filename) {

  /**
   * This function is used to generate the name of the secret.
   * It is used to generate the name of the secret from the namespace, the
   * folder path and the filename.
   *
   * It standardizes the inputs by replacing spaces, slashes and dots with
   * underscores.
   * It also removes leading and trailing underscores from the inputs.
   *
   * This is the default implementation to generate the secret name. A numeric
   * suffix is added to the secret name corresponding to the version of the
   * secret, but this is not done in this function.
   */

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
  namespace = namespace.trim()
    .replaceAll(" ", "_")
    .replaceAll("/", "_")
    .replaceAll(".", "_")
    .replaceAll(/^_+|_+$/gm,'');

  const name = namespace + "_" + part1 + "_" + part2
  return name
}

export { generate_name };