const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const { receiptUpload } = require('../middleware/uploadMiddleware');
const { uploadReceipt, receiptUrl, deleteReceipt } = require('../controllers/attachmentController');

// W3-24. Multer runs after auth so the key can be filed under the caller.
router.post  ('/receipts/:clientId',     auth, receiptUpload.single('file'), uploadReceipt);
router.get   ('/receipts/:clientId/url', auth, receiptUrl);
router.delete('/receipts/:clientId',     auth, deleteReceipt);

module.exports = router;
