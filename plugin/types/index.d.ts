export type ProbeCount = number

declare module 'claude-code' {
  interface PluginState {
    atelier: { count: ProbeCount }
  }
}
