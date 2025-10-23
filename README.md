# OFD Viewer (NestJS + TypeScript)

An OFD file previewer that serves both backend and frontend in one NestJS application. Provides API endpoints to fetch metadata, render pages as SVG/PNG/PDF, optional upload, and a lightweight viewer page with toolbar.

This implementation focuses on safety and simplicity while providing a working path to view typical text-only OFD pages. It includes a minimal sample OFD file generated on startup at `/data/sample.ofd`.

## Features

- Preview OFD via browser: http://127.0.0.1:3000/url?file=/data/sample.ofd
- APIs
  - GET `/api/ofd/metadata?file=...` — pages, size (mm), title, author, creation date, extractable text flag, negotiated capabilities, active renderer
  - GET `/api/ofd/page?file=...&page=<n>&format=svg|png|pdf` — render a page as SVG/PNG/PDF
  - GET `/api/ofd/text?file=...&page=<n>` — extract text positions for a page (if possible)
  - POST `/api/upload` — upload OFD and get a temporary `id` to reference as `file=id:<id>`
  - GET `/api/ofd/raw?file=...` — download the original OFD
- Frontend `/url` page
  - Fixed toolbar with zoom in/out/reset, previous/next, goto page, download current page (PNG/PDF), download original OFD, toggle text selection
  - Smooth CSS transform zoom; SVG stays crisp at high zoom
  - Keyboard shortcuts: `+` zoom in, `-` zoom out, `0` reset, arrow keys turn pages, Ctrl/Cmd+F shows search placeholder
  - Basic touch: swipe to turn pages, pinch to zoom
  - Loading and error states
- Caching: in-memory LRU for parsed docs and rendered SVG pages (TTL 10 min)
- Security: path is restricted to OFD_ROOT or upload ids; prevents path traversal; file size limits
- Limits: file size, parse timeout, helpful error codes

## Compatibility and Rendering Strategies

`src/ofd/parser.ts` now orchestrates a chain of rendering strategies so that the backend can adapt to different levels of OFD complexity without code changes:

1. **OFDRW CLI strategy (optional).** When the environment variable `OFDRW_CLI` points to a binary or script that understands the expected CLI contract, the service delegates metadata extraction and page rendering to it. This is ideal for wrappers around [ofdrw](https://github.com/ofdrw/ofdrw) or any other robust renderer and unlocks support for complex graphics, embedded fonts, annotations, and electronic signatures.
2. **Basic XML fallback.** If no CLI is configured (or the CLI becomes unavailable), the built-in TypeScript strategy parses the OFD package directly and renders TextObject/TextCode instructions into SVG. This preserves the previous behaviour and keeps the application self-contained.

The parser automatically uses the first available strategy and falls back when a strategy errors out. Metadata responses now return a `capabilities` object describing the negotiated features (text, vector drawing, images, annotations, signatures) so the frontend can react accordingly.

When only the basic strategy is active, the following limitations remain:
- Complex graphics (paths, images, clipping, CTM transforms) are not drawn
- Fonts defined in resource packages are not embedded; system fallbacks are used
- Advanced layout features such as vertical text, kerning, or glyph substitutions are ignored
- Annotations, stamps, and e-seals are not rendered
- Multi-document OFD packages remain unsupported

Configure an OFDRW-compatible CLI to unlock the advanced features required for production workloads.

## Getting Started

Requirements: Node.js 18+.

1. Install dependencies

```bash
npm install
```

2. Run in development

```bash
npm run start:dev
```

This will start the server at http://127.0.0.1:3000 and auto-generate a sample OFD at `/data/sample.ofd`.

Open the viewer:

- http://127.0.0.1:3000/url?file=/data/sample.ofd
- or http://127.0.0.1:3000/url?file=sample.ofd (relative to OFD_ROOT)

3. Build & run production

```bash
npm run build
npm run start:prod
```

### Environment Variables

- `PORT` — server port (default 3000)
- `OFD_ROOT` — the root directory for OFD files (default `/data`). Absolute paths are only allowed if inside this directory. The sample file is created here.
- `MAX_OFD_SIZE` — maximum OFD size in bytes (default 104857600, i.e., 100 MiB)
- `OFDRW_CLI` — optional path to an executable or script that implements the OFDRW-compatible CLI used by `OfdService`
- `OFDRW_TIMEOUT` — override the CLI invocation timeout in milliseconds (default 20000)
- `OFDRW_DISABLE` — set to `true`/`1`/`yes` to skip the OFDRW strategy even when `OFDRW_CLI` is configured
- `OFDRW_KEEP_ARTIFACTS` — set to `1` to retain temporary working directories produced by the CLI for debugging

### OFDRW CLI Contract

When `OFDRW_CLI` is configured the command is invoked with the following expectations:

- `OFDRW_CLI metadata <input.ofd>` must write a JSON object to `stdout` containing:
  ```json
  {
    "meta": { "pages": 1, "widthMM": 210, "heightMM": 297, "title": "...", "author": "...", "creationDate": "...", "textExtractable": true },
    "capabilities": { "text": true, "vector": true, "images": true, "annotations": true, "signatures": true },
    "pageRefs": ["page-1", "page-2"]
  }
  ```
  `capabilities` and `pageRefs` are optional; sensible defaults are applied when they are omitted.
- `OFDRW_CLI render --page <n> --format svg --output <outputBase> <input.ofd>` must create `<outputBase>.svg`. Optionally write `<outputBase>.json` with an array of text items that match `PageTextItem`.

Any script or binary that fulfils this contract can drive the advanced renderer.

### Uploading Files

- `POST /api/upload` with a multipart form field `file`
- Response returns `{ id, file: 'id:<id>' }`
- Use that value as the `file` query parameter, e.g. `/url?file=id:<id>`

## API Examples

- Metadata: `GET /api/ofd/metadata?file=/data/sample.ofd`
- First page SVG: `GET /api/ofd/page?file=/data/sample.ofd&page=1&format=svg`
- First page PNG: `GET /api/ofd/page?file=/data/sample.ofd&page=1&format=png`
- First page PDF: `GET /api/ofd/page?file=/data/sample.ofd&page=1&format=pdf`
- Text layer: `GET /api/ofd/text?file=/data/sample.ofd&page=1`
- Raw download: `GET /api/ofd/raw?file=/data/sample.ofd`

All endpoints enforce path restrictions to stay within `OFD_ROOT`.

## Tests

Run tests:

```bash
npm test
```

Included tests (at least 3):
- Metadata success for sample
- Page render success (SVG and PNG)
- Metadata error for non-existing file

## Docker (optional)

A simple Dockerfile is provided. Build and run:

```bash
docker build -t ofd-viewer .
docker run --rm -p 3000:3000 -e OFD_ROOT=/data -v $(pwd)/data:/data ofd-viewer
```

The container will create `/data/sample.ofd` on first start if not present.

## Extending the Renderer

The strategy pipeline in `src/ofd/parser.ts` is intentionally open-ended:
- Point `OFDRW_CLI` at any command that produces metadata JSON and per-page SVG (with optional text JSON) following the documented contract to gain full OFD compatibility via external renderers such as ofdrw.
- Implement your own `OfdRenderingStrategy` (for example, an HTTP bridge or a WASM renderer) and pass it to `new OfdParser({ strategies: [...] })` inside `OfdService` if you need tighter control.

Unsupported features still surface readable errors and the viewer informs the user with options to retry or upload another file.
