# Swarm UpdateD

The Swarm UpdateD is a simple process that updates docker secrets depending on the latest modifications done on files
present in a set of directories on the filesystem. For each file present in this directory, the process will watch for
any change performed during a configurable time period. This feature uses UNIX filesystem events, and may not work
properly on Windows systems. If a change occured during this period on a file, then it proceeds to:

1. Generate a swarm secret name from the filename and a configurable namespace. For clarity sake, this name
name will be referred to as the `identifier` for a secret.
2. Check if secrets with a corresponding `identifier` already exist in the current docker swarm chorum. If they exist,
Swarm UpdateD will use the highest integer label `updated.swarm.<namespace>` on the secret as a version for the
considered secret. If the label does not exist, the version is assumed to be zero, and the label is set by Swarm
UpdateD.
3. Create a new secret, with a version incremented by 1. The name for this new secret will be `<identifier>.<version>`.
4. Update any service using the previous secret to its new version, wait for the update to complete.
5. Remove any secret with outdated version labels.

The default time period between udapte checks is 5 seconds in the provided `fxia/swarm_updated` container, and 1 second
in the provided testing configuration.

I wrote this service because I had a process generating SSL certificates for various applications in my swarm stacks. I
use this tool to perform an automatic renewal of such certificates. I am very open to suggestions. I am particularly
interested in feedback concerning security implications.

## Requirements

 - node==18.15.0 Some other versions may work, I only tested with this version.
 - A configured and running swarm manager deamon, with sufficient priviledge to access it

## Running the service

### Testing or Development

A test folder contains a minimal configuration to easily test the service without running it inside a container. I am
a bit conservative concerning the supported configuration, because Docker can be configured in quite different ways.
Given your usual `/var/run/docker.sock` entrypoint for your Docker daemon, that should be available on UNIX systems
after completing the standard docker installation, on should be able to run the test configuration with:

```
$ node index.js
```

The process will create 2 test secret. One can test the update of the secrets by editing the files
`test_secrets/test_secret` and `test_secret/nested/nested_secret`.

### Production

Using Docker to deploy this service in production is recommanded. The provided Dockerfile may help you rebuild an image
fitting your own need. Otherwise one may use the `fxia/swarm_updated` image, publicly available.

#### Configuring Swarm UpdateD

The first step to deploy this service in production is to create a configuration file. This configuration must be
written in JSON format. The [config](https://github.com/node-config/node-config#readme) npm module is used ot combine
several configuration files. The JSON configuration should thus be mapped to `/app/config/production.json` inside your
container. Example configuration can be seen in the config folder. The `./config/docker_default.json` is used in the
`fxia/swarm_updated` image as a default.

#### Setting the Docker API configuration

By default, Swarm UpdateD will use the socket available at `/var/run/docker.sock` and assumes that it has sufficient
priviledge to run. These settings can be overwritten by adding a `docker` JSON object to your configuration file. This
configuration object will be passed as is to the [dockerode](https://github.com/apocas/dockerode) package. Please
refer to their documentation to see what can be changed in this configuration object. Here is an example if you wish to
use another Docker host, with a specific port:

`production.json`:
```
{
    "docker": {
        host: 'http://192.168.1.10',
        port: 3000
    }
}
```

#### Setting a folder to watch for file changes

By default, the `fxia/swarm_updated` image will not update anything. One must list the directories on the image
filesystem to watch for changes. Each directory may be attached to a namespace to help users to avoid name clashes in
generated swarm secrets. Here is an example watching two folders `/etc/ssl/certs` and `/my/folder/with/sensitive/data`,
assigned with the `certificates` and `passwords` namespaces respectively:

`production.json`:
```
{
    "secret_folder": {
        "certificates": "/etc/ssl/certs",
        "passwords": "/my/folder/with/sensitive/data"
    }
}
```

I do not recommand using this above configuration in production, never did, and will deny any responsibility if you dare
using it.

#### Configuring logs

As a developer for this service, I prefer to have access to rather verbose logs, but I can understand that someone does
not want his disk to be cluttered with meaningless information. Fortunately, this service uses the quite flexible
[winston](https://github.com/winstonjs/winston) module for logging. As for dockerode, I recommand to check their own
documentation. The logging configuration can be set using the `logging` field in your `production.json`. Example,
setting the loglevel to warning, and removing the default formatters set for Swarm UpdateD:

`production.json`
```
{
    "logging": {
        "transport": {
        "console": [
            {
                "level": "warn",
                "handleExceptions": true,
                "json": false,
                "colorize": true
            }
        ]
        },
        "formatters": []
    }
}

```

#### Setting the update interval

Use the `updateInterval` field in the `production.json` file. Use an integer value representing the waiting between
updates in milliseconds. Defaults to 5 seconds. I recommand using at least 30 sec inproduction, but this may well
depend on your use case.

`production.json`
```
{
    "updateInterval": 30000,
}
```

#### Docker Swarm

It is highly recommanded that you define a `compose.yml` file suitable for using with the `docker stack deploy` command
to setup your volumes, config, and secrets. However, this configuration may depend so much on the end user setup and end
goal that I decided to not provide an example that would be irrelevant to most cases. Most likely if you have the need
for this service, you will know how to write such configuration, but I am willing to help in case of trouble :)

## Future developments:

 - Add an API to programmatically force an update
 - Add support for message passing frameworks to programmatically force an update
 - Implement a priority system in case of multiple updates occuring during the same time period from different sources
 - Improve inline code documentation, provide a separate code doc in readthedocs, or github pages... etc.
