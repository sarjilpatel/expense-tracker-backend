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
  getCategoryPresets,
  applyCategoryPreset,
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
// Named packs, so a wedding or a trip is one tap instead of twelve.
router.get( "/categories/presets",            auth, getCategoryPresets);
router.post("/categories/presets/:key",       auth, applyCategoryPreset);
// Superseded by the line above; kept so an older build of the app keeps working.
router.post("/categories/wedding-preset",     auth, setupWeddingCategories);

module.exports = router;
