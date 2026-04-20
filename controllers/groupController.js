const Group = require("../models/Group");
const User = require("../models/User");
const crypto = require("crypto");

exports.createGroup = async (req, res) => {
    try {
        const { groupName } = req.body;
        const userId = req.user.id;

        const inviteCode = crypto.randomBytes(3).toString("hex").toUpperCase();

        const group = await Group.create({
            name: groupName,
            inviteCode,
            members: [userId]
        });

        await User.findByIdAndUpdate(userId, { groupId: group._id });

        res.json(group);
    } catch (error) {
        res.status(500).json({ message: "Failed to create group" });
    }
};

exports.joinGroup = async (req, res) => {
    try {
        const { inviteCode } = req.body;
        const userId = req.user.id;

        if (!inviteCode) return res.status(400).json({ message: "Invite code is required" });

        const group = await Group.findOne({ inviteCode: inviteCode.trim().toUpperCase() });

        if (!group) return res.status(404).json({ message: "Invalid invite code" });

        // Ensure we check membership correctly (ObjectId vs String)
        const isAlreadyMember = group.members.some(memberId => memberId.toString() === userId);

        if (!isAlreadyMember) {
            group.members.push(userId);
            await group.save();
        }

        await User.findByIdAndUpdate(userId, { groupId: group._id });

        res.json(group);
    } catch (error) {
        console.error('Join group error:', error);
        res.status(500).json({ message: "Failed to join group" });
    }
};

exports.getGroupDetails = async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);
        
        if (!user.groupId) {
            return res.status(404).json({ message: "You are not in any group" });
        }

        const group = await Group.findById(user.groupId).populate("members", "name email");
        res.json(group);
    } catch (error) {
        res.status(500).json({ message: "Server error fetching group details" });
    }
};

exports.getUserGroups = async (req, res) => {
    try {
        const userId = req.user.id;
        const groups = await Group.find({ members: userId });
        res.json(groups);
    } catch (error) {
        res.status(500).json({ message: "Server error fetching groups" });
    }
};

exports.switchActiveGroup = async (req, res) => {
    try {
        const { groupId } = req.body;
        const userId = req.user.id;

        const group = await Group.findOne({ _id: groupId, members: userId });
        if (!group) return res.status(403).json({ message: "Access denied to this group" });

        await User.findByIdAndUpdate(userId, { groupId });
        res.json({ message: "Switched successfully", groupId });
    } catch (error) {
        res.status(500).json({ message: "Failed to switch group" });
    }
};