const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname);

// Monorepo: keep Expo's defaults and add the workspace root (do not replace them).
config.watchFolders = Array.from(new Set([...config.watchFolders, root]));
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules"), path.join(root, "node_modules")];

module.exports = config;
