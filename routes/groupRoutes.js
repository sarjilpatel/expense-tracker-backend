const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { createGroup, joinGroup, getGroupDetails, getUserGroups, switchActiveGroup } = require("../controllers/groupController");

router.post("/create", auth, createGroup);
router.post("/join", auth, joinGroup);
router.get("/details", auth, getGroupDetails);
router.get("/my-groups", auth, getUserGroups);
router.post("/switch", auth, switchActiveGroup);

module.exports = router;