import busboy from 'busboy';

export class HttpRequestAdapter {
  constructor(ingestionPipeline) {
    this.ingestionPipeline = ingestionPipeline;
  }

  async consumeHttpRequest(req) {
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('multipart/form-data')) {
      return new Promise((resolve, reject) => {
        let fileStreamPromise = null;
        const bb = busboy({ headers: req.headers });
        
        bb.on('file', (name, file, info) => {
          const { filename, mimeType } = info;
          // We assume there's only one file or we only care about the first one.
          if (!fileStreamPromise) {
            const metadata = {
              declaredSize: null, // Hard to know exact file size in multipart upfront without parsing
              mimeType,
              originalFilename: filename
            };
            fileStreamPromise = this.ingestionPipeline.ingest(file, metadata)
              .then(resolve)
              .catch(reject);
          } else {
            // Drain any other files
            file.resume();
          }
        });
        
        bb.on('error', (err) => {
          reject(err);
        });

        req.pipe(bb);
      });
    } else {
      // Direct raw binary stream
      const declaredSize = req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : null;
      const originalFilename = req.headers['x-file-name'] || null;

      const metadata = {
        declaredSize,
        mimeType: contentType || 'application/octet-stream',
        originalFilename
      };

      return this.ingestionPipeline.ingest(req, metadata);
    }
  }
}
