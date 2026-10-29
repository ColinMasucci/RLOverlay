const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");
const path = require("path");

module.exports = defineConfig({
    root: path.join(__dirname, "renderer"),
    base: "./",
    plugins: [react()],
    build: {
        outDir: path.join(__dirname, "dist"),
        emptyOutDir: true,
        rollupOptions: {
            input: {
                index: path.join(__dirname, "renderer", "index.html"),
                settings: path.join(__dirname, "renderer", "settings.html"),
                status: path.join(__dirname, "renderer", "status.html")
            }
        }
    }
});
