const express = require("express");
const router = express.Router();
const { signup, login, getMe, updateProfile } = require("../controllers/authController");
const auth = require("../middleware/authMiddleware");
const upload = require("../middleware/uploadMiddleware");

router.post("/signup", signup);
router.post("/login", login);
router.get("/me", auth, getMe);
router.put("/update-profile", auth, upload.single("photo"), updateProfile);

module.exports = router;