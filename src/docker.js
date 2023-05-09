import config from 'config';
import Docker from 'dockerode';

const docker = new Docker(config.get("docker"));

export default docker;