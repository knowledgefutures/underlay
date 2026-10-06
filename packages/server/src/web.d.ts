// @underlay/web ships built JavaScript (dist/server/entry-server.js); this is its contract.
declare module '@underlay/web' {
  export const renderPage: import('./app.js').RenderPage
}
