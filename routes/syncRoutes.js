const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { push, changes } = require('../controllers/syncController');

// W3-07/08. Both are idempotent; see controllers/syncController.js.
router.post('/push',    authMiddleware, push);
router.get('/changes',  authMiddleware, changes);

module.exports = router;
