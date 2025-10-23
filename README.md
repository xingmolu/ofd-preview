# OFD Viewer (NestJS + TypeScript)

An OFD file previewer that serves both backend and frontend in one NestJS application. Provides API endpoints to fetch metadata, render pages as SVG/PNG/PDF, optional upload, and a lightweight viewer page with toolbar.

This implementation focuses on safety and simplicity while providing a working path to view typical text-only OFD pages. It includes a minimal sample OFD file generated on startup at `/data/sample.ofd`.

## Features

- Preview OFD via browser: http://127.0.0.1:3000/url?file=/data/sample.ofd
- APIs
  - GET `/api/ofd/metadata?file=...` — pages, size (mm), title, author, creation date, whether text extractable
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

## Compatibility and Strategy

This project uses a simple OFD XML parser that supports a subset of OFD:
- Reads `OFD.xml` for DocInfo and Document path
- Parses `Document.xml` for page list and `PageArea.PhysicalBox` (page size in mm)
- Renders pages by handling `Content/Layer/TextObject/TextCode` with `X`, `Y`, and `Size` attributes into SVG `<text>` nodes

Tested and compatible with:
- The bundled sample at `/data/sample.ofd` (text-only, 1-page)
- OFD files that primarily contain simple TextObject/TextCode instructions without complex fonts/resources/CTM

Known limitations (not yet supported or partially supported):
- Complex graphics (paths, images, clipping, CTM transforms)
- Fonts defined in resources, character mapping, kerning, vertical text, glyph substitutions
- Multi-layer interactions, annotations, e-seals, signatures
- Multi-document OFD packages

If your OFD relies on vendor-specific extensions or advanced features (some government systems, certain export tools), the renderer may fail to parse or show a simplified placeholder. In such cases:
- Use `format=svg` for best fidelity when text objects exist
- Try exporting the OFD using a different tool or a simplified layout
- Consider integrating a mature converter such as [ofdrw (Java)](https://github.com/ofdrw/ofdrw) in a sidecar service, then adapt `OfdService` to call it for universal rendering

The code is structured so the parsing/rendering layer can be replaced with a more feature-complete library or a service call.

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

## Replacing the Parser/Renderer

For better compatibility with mainstream OFD implementations (including X-OFD and various vendor exports), consider integrating a robust converter:
- Java: ofdrw-converter to SVG/PDF/PNG; expose via HTTP or CLI and adapt `OfdService`
- Native services: connect to an internal rendering service that supports your files

This code isolates parsing in `src/ofd/parser.ts` so you can swap it with a more complete approach. When unsupported features are encountered, APIs return readable errors, and the viewer shows an error message with options to retry or upload another file.
