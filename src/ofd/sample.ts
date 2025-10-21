import JSZip from 'jszip';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

export async function ensureSampleData() {
  const root = process.env.OFD_ROOT || '/data';
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  const samplePath = path.join(root, 'sample.ofd');
  if (!existsSync(samplePath)) {
    const zip = new JSZip();

    const ofdXml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<OFD xmlns="http://www.ofdspec.org/2016" DocType="OFD" Version="1.1">\n` +
      `  <DocBody>\n` +
      `    <DocInfo>\n` +
      `      <Title>Sample OFD</Title>\n` +
      `      <Author>cto.new</Author>\n` +
      `      <CreationDate>2025-01-01T00:00:00</CreationDate>\n` +
      `    </DocInfo>\n` +
      `    <Document>Doc_0/Document.xml</Document>\n` +
      `  </DocBody>\n` +
      `</OFD>`;

    const documentXml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n` +
      `<Document xmlns=\"http://www.ofdspec.org/2016\">\n` +
      `  <CommonData>\n` +
      `    <PageArea>\n` +
      `      <PhysicalBox>0 0 210 297</PhysicalBox>\n` +
      `    </PageArea>\n` +
      `  </CommonData>\n` +
      `  <Pages>\n` +
      `    <Page ID=\"1\" BaseLoc=\"Doc_0/Pages/Page_0/Content.xml\"/>\n` +
      `  </Pages>\n` +
      `</Document>`;

    const pageXml = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n` +
      `<Page xmlns=\"http://www.ofdspec.org/2016\">\n` +
      `  <Area>\n` +
      `    <PhysicalBox>0 0 210 297</PhysicalBox>\n` +
      `  </Area>\n` +
      `  <Content>\n` +
      `    <Layer ID=\"1\">\n` +
      `      <TextObject ID=\"2\" Boundary=\"10 10 190 20\" Size=\"12\" Font=\"0\">\n` +
      `        <TextCode X=\"20\" Y=\"40\">Hello OFD</TextCode>\n` +
      `        <TextCode X=\"20\" Y=\"60\">欢迎使用 OFD Viewer</TextCode>\n` +
      `      </TextObject>\n` +
      `    </Layer>\n` +
      `  </Content>\n` +
      `</Page>`;

    zip.file('OFD.xml', ofdXml);
    zip.file('Doc_0/Document.xml', documentXml);
    zip.file('Doc_0/Pages/Page_0/Content.xml', pageXml);

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    writeFileSync(samplePath, buf);
  }

  // also place public assets into ./public if missing
  const publicDir = path.join(process.cwd(), 'public');
  if (!existsSync(publicDir)) mkdirSync(publicDir, { recursive: true });
}
