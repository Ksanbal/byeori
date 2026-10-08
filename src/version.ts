import metadata from '../package.json';

/** Package version is the single release/runtime version source, embedded by the bundler. */
export const RUNTIME_VERSION = metadata.version;
