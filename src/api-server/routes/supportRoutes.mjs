// @ts-check
import { Router } from 'express';
import busboy from 'busboy';
import fs from 'node:fs';
import path from 'node:path';

export const supportRouter = Router();

supportRouter.get('/snapshot', (req, res) => {
  res.json({
    openTicketCount: 0,
    contactMethods: [
      {
        id: 'ticket',
        title: 'Support Ticket',
        description: 'Submit an operational ticket for engineering assistance',
        actionType: 'INTERNAL_ROUTE',
        actionTarget: '/workspace/support/tickets/new',
        available: true
      },
      {
        id: 'chat',
        title: 'Live Chat',
        description: 'Direct telegram channel support desk',
        actionType: 'EXTERNAL_LINK',
        actionTarget: 'https://t.me/betting_automation_support',
        available: true
      }
    ],
    documentationState: { cached: true, sections: [] },
    documentationLastSync: new Date().toISOString(),
    systemHealthSummary: 'Healthy'
  });
});

supportRouter.post('/tickets', (req, res) => {
  const ticketId = `tkt_${Date.now()}`;
  res.status(201).json({ ticketId, status: 'OPEN' });
});

supportRouter.post('/attachments', (req, res) => {
  if (!req.headers['content-type']?.includes('multipart/form-data')) {
    return res.status(400).json({ error: 'Content-Type must be multipart/form-data' });
  }

  const bb = busboy({ headers: req.headers });
  let savedFile = null;

  bb.on('file', (name, file, info) => {
    const { filename } = info;
    const fileId = `att_${Date.now()}`;
    const tempDir = path.resolve('scratch/attachments');
    fs.mkdirSync(tempDir, { recursive: true });
    const dest = path.join(tempDir, `${fileId}_${filename}`);
    
    let sizeBytes = 0;
    const writeStream = fs.createWriteStream(dest);
    file.on('data', chunk => { sizeBytes += chunk.length; });
    file.pipe(writeStream);

    writeStream.on('finish', () => {
      savedFile = { fileId, fileName: filename, sizeBytes };
    });
  });

  bb.on('close', () => {
    if (!savedFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.status(201).json(savedFile);
  });

  req.pipe(bb);
});

supportRouter.post('/diagnostics', (req, res) => {
  res.json({ reportId: `diag_${Date.now()}`, status: 'RECEIVED' });
});
