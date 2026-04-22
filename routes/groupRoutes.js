const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { 
  createGroup, 
  joinGroup, 
  getGroupDetails, 
  getUserGroups, 
  switchActiveGroup,
  addCategory,
  removeCategory,
  importCategories,
  setupWeddingCategories
} = require("../controllers/groupController");

router.post("/create", auth, createGroup);
router.post("/join", auth, joinGroup);
router.get("/details", auth, getGroupDetails);
router.get("/my-groups", auth, getUserGroups);
router.post("/switch", auth, switchActiveGroup);

// Categories
router.post("/categories", auth, addCategory);
router.delete("/categories/:categoryId", auth, removeCategory);
router.post("/categories/import", auth, importCategories);
router.post("/categories/wedding-preset", auth, setupWeddingCategories);

module.exports = router;