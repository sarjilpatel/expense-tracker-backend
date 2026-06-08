const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/authMiddleware');
const {
  getGoals, createGoal, updateGoal, deleteGoal,
} = require('../controllers/goalController');

router.get('/',     auth, getGoals);
router.post('/',    auth, createGoal);
router.put('/:id',  auth, updateGoal);
router.delete('/:id', auth, deleteGoal);

module.exports = router;
