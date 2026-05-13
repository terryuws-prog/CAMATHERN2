import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".yaml": "application/yaml; charset=utf-8",
};

function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, `http://localhost:${port}`).pathname);
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(root, safePath === "/" ? "index.html" : safePath);
  return candidate.startsWith(root) ? candidate : join(root, "index.html");
}

createServer(async (request, response) => {
  let filePath = resolvePath(request.url);
  if (!existsSync(filePath)) filePath = join(root, "index.html");

  const fileStat = await stat(filePath);
  if (fileStat.isDirectory()) filePath = join(filePath, "index.html");

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": types[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}).listen(port, () => {
  console.log(`Catchment dashboard running at http://localhost:${port}`);
});
