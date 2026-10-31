// Platform-resolved local store:
// - native: local.ts (expo-sqlite)
// - web:    local.web.ts (IndexedDB, picked by Metro's platform-extension resolution)
// Never import local.web explicitly from shared code: that would break Android/iOS.
export * from "./local";
