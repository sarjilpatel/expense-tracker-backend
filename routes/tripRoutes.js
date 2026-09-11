const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const {
  getTrips, getTrip, createTrip, updateTrip, deleteTrip,
  addMember, updateMember, removeMember,
  addExpense, updateExpense, deleteExpense,
  addSettlement, deleteSettlement,
} = require('../controllers/tripController');

router.get('/',        auth, getTrips);
router.post('/',       auth, createTrip);
router.get('/:id',     auth, getTrip);
router.patch('/:id',   auth, updateTrip);
router.delete('/:id',  auth, deleteTrip);

router.post('/:id/members',              auth, addMember);
router.patch('/:id/members/:memberId',   auth, updateMember);
router.delete('/:id/members/:memberId',  auth, removeMember);

router.post('/:id/expenses',              auth, addExpense);
router.patch('/:id/expenses/:expenseId',  auth, updateExpense);
router.delete('/:id/expenses/:expenseId', auth, deleteExpense);

// A recorded payment is a row, so undoing one is a DELETE of that row rather than a second kind of
// settle flag (W1-29).
router.post('/:id/settlements',                    auth, addSettlement);
router.delete('/:id/settlements/:settlementId',    auth, deleteSettlement);

module.exports = router;
