const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const {
  getSplits, createSplit, settleSplit, deleteSplit,
} = require('../controllers/splitController');

router.get('/',                     auth, getSplits);
router.post('/',                    auth, createSplit);
router.patch('/:id/settle/:userId', auth, settleSplit);
router.delete('/:id',               auth, deleteSplit);

module.exports = router;
