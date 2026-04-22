const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

exports.signup = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: "User already exists" });
        }

        const hashed = await bcrypt.hash(password, 10);
        const user = await User.create({
            name,
            email,
            password: hashed
        });

        const userResponse = user.toObject();
        delete userResponse.password;

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.json({ token, user: userResponse });
    } catch (error) {
        console.error("Signup Error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const userResponse = user.toObject();
        delete userResponse.password;

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

        res.json({ token, user: userResponse });
    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMe = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select("-password").populate("groupId");
        res.json(user);
    } catch (error) {
        res.status(500).json({ message: "Server Error" });
    }
};

exports.updateProfile = async (req, res) => {
    try {
        const { name } = req.body;
        const userId = req.user.id;
        const updatedFields = {};
        
        if (name) updatedFields.name = name;
        if (req.file) {
            updatedFields.profilePhoto = req.file.location; // S3 URL from multer-s3
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { $set: updatedFields },
            { new: true }
        ).select("-password");

        res.json(user);
    } catch (error) {
        console.error("Update Profile Error:", error);
        res.status(500).json({ message: "Failed to update profile" });
    }
};