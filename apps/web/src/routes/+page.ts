// La portada se genera como HTML estático al compilar (con su contenido y sus
// metadatos), para que los buscadores la lean sin ejecutar JavaScript.
// El resto de la aplicación sigue siendo una SPA.
export const ssr = true;
export const prerender = true;
