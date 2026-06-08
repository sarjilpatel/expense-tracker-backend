const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/authMiddleware");
const {
  createGroup,
  requestToJoinGroup,
  getPendingRequests,
  approveJoinRequest,
  rejectJoinRequest,
  getGroupDetails,
  getUserGroups,
  switchActiveGroup,
  addCategory,
  removeCategory,
  importCategories,
  setupWeddingCategories,
} = require("../controllers/groupController");

router.post("/create",  auth, createGroup);
router.post("/join",    auth, requestToJoinGroup);   // now sends a request, not instant join
router.get("/details",  auth, getGroupDetails);
router.get("/my-groups",auth, getUserGroups);
router.post("/switch",  auth, switchActiveGroup);

// Join request management (owner only)
router.get( "/:groupId/pending",              auth, getPendingRequests);
router.post("/:groupId/approve/:userId",      auth, approveJoinRequest);
router.post("/:groupId/reject/:userId",       auth, rejectJoinRequest);

// Categories
router.post("/categories",                    auth, addCategory);
router.delete("/categories/:categoryId",      auth, removeCategory);
router.post("/categories/import",             auth, importCategories);
router.post("/categories/wedding-preset",     auth, setupWeddingCategories);

module.exports = router;
