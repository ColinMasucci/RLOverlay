const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");
const path = require("path");

function redirectBrowserRoot() {
    return {
        name: "redirect-browser-root",
        configureServer(server) {
            server.middlewares.use((request, response, next) => {
                if (request.url === "/" || request.url?.startsWith("/?")) {
                    response.statusCode = 302;
                    response.setHeader("Location", "/party.html");
                    response.end();
                    return;
                }
                next();
            });
        }
    };
}

module.exports = defineConfig({
    root: path.join(__dirname, "renderer"),
    envDir: __dirname,
    base: "./",
    plugins: [react(), redirectBrowserRoot()],
    build: {
        outDir: path.join(__dirname, "dist"),
        emptyOutDir: true,
        rollupOptions: {
            input: {
                index: path.join(__dirname, "renderer", "index.html"),
                settings: path.join(__dirname, "renderer", "settings.html"),
                status: path.join(__dirname, "renderer", "status.html"),
                party: path.join(__dirname, "renderer", "party.html")
            }
        }
    }
});
