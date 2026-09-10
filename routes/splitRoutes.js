const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const {
  getSplits, createSplit, settleSplit, unsettleSplit, deleteSplit,
} = require('../controllers/splitController');

router.get('/',                     auth, getSplits);
router.post('/',                    auth, createSplit);
router.patch('/:id/settle/:userId', auth, settleSplit);
// Undoing a Mark Paid is deleting the settlement, not a second kind of settle (W1-29).
router.delete('/:id/settle/:userId', auth, unsettleSplit);
router.delete('/:id',               auth, deleteSplit);

module.exports = router;
