const Group = require("../models/Group");
const User = require("../models/User");
const crypto = require("crypto");

async function generateUniqueJoinCode() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = crypto.randomBytes(3).toString("hex").toUpperCase();
        const existing = await Group.findOne({ joinCode: code });
        if (!existing) return code;
    }
    throw new Error("Failed to generate unique join code after 5 attempts");
}

exports.createGroup = async (req, res) => {
    try {
        const rawName = req.body.groupName;
        if (!rawName || typeof rawName !== 'string') {
            return res.status(400).json({ message: "Group name is required" });
        }
        const groupName = rawName.trim().slice(0, 50);
        if (!groupName) return res.status(400).json({ message: "Group name cannot be empty" });

        const userId   = req.user.id;
        const joinCode = await generateUniqueJoinCode();

        const group = await Group.create({
            name:    groupName,
            joinCode,
            owner:   userId,
            members: [userId],
        });

        await User.findByIdAndUpdate(userId, { groupId: group._id });

        res.json(group);
    } catch (error) {
        res.status(500).json({ message: "Failed to create group" });
    }
};

// Submit a join request — owner must approve before the user is added
exports.requestToJoinGroup = async (req, res) => {
    try {
        const { inviteCode, joinCode: bodyJoinCode } = req.body;
        const userId = req.user.id;

        const codeToFind = (inviteCode || bodyJoinCode || '').trim().toUpperCase();
        if (!codeToFind) return res.status(400).json({ message: "Join code is required" });

        const group = await Group.findOne({ joinCode: codeToFind });
        if (!group) return res.status(404).json({ message: "Invalid join code" });

        const alreadyMember  = group.members.some(id => id.toString() === userId);
        if (alreadyMember) return res.status(400).json({ message: "You are already a member of this group" });

        const alreadyPending = group.pendingMembers.some(p => p.userId.toString() === userId);
        if (alreadyPending) return res.status(400).json({ message: "Join request already pending approval" });

        group.pendingMembers.push({ userId });
        await group.save();

        // Notify the group owner via socket if they're connected
        const io = req.app.get("io");
        if (io && group.owner) {
            io.to(group._id.toString()).emit("join_request", { groupId: group._id, userId });
        }

        res.json({ message: "Join request sent. Waiting for owner approval." });
    } catch (error) {
        console.error('Join request error:', error);
        res.status(500).json({ message: "Failed to send join request" });
    }
};

// Get pending join requests — only the group owner can see these
exports.getPendingRequests = async (req, res) => {
    try {
        const userId  = req.user.id;
        const groupId = req.params.groupId;

        const group = await Group.findOne({ _id: groupId, owner: userId })
            .populate('pendingMembers.userId', 'name email profilePhoto');

        if (!group) return res.status(403).json({ message: "Access denied" });

        res.json(group.pendingMembers);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch pending requests" });
    }
};

// Approve a join request — only the group owner
exports.approveJoinRequest = async (req, res) => {
    try {
        const ownerId         = req.user.id;
        const { groupId, userId } = req.params;

        const group = await Group.findOne({ _id: groupId, owner: ownerId });
        if (!group) return res.status(403).json({ message: "Access denied" });

        const pendingIndex = group.pendingMembers.findIndex(p => p.userId.toString() === userId);
        if (pendingIndex === -1) return res.status(404).json({ message: "No pending request from this user" });

        // Move from pending to members
        group.pendingMembers.splice(pendingIndex, 1);
        if (!group.members.some(id => id.toString() === userId)) {
            group.members.push(userId);
        }
        await group.save();

        // Set groupId on the approved user (only if they don't already have one)
        const approvedUser = await User.findById(userId);
        if (approvedUser && !approvedUser.groupId) {
            await User.findByIdAndUpdate(userId, { groupId: group._id });
        }

        const io = req.app.get("io");
        if (io) io.to(group._id.toString()).emit("member_joined", { groupId: group._id, userId });

        res.json({ message: "User approved and added to the group" });
    } catch (error) {
        res.status(500).json({ message: "Failed to approve request" });
    }
};

// Reject a join request — only the group owner
exports.rejectJoinRequest = async (req, res) => {
    try {
        const ownerId         = req.user.id;
        const { groupId, userId } = req.params;

        const group = await Group.findOne({ _id: groupId, owner: ownerId });
        if (!group) return res.status(403).json({ message: "Access denied" });

        const pendingIndex = group.pendingMembers.findIndex(p => p.userId.toString() === userId);
        if (pendingIndex === -1) return res.status(404).json({ message: "No pending request from this user" });

        group.pendingMembers.splice(pendingIndex, 1);
        await group.save();

        res.json({ message: "Join request rejected" });
    } catch (error) {
        res.status(500).json({ message: "Failed to reject request" });
    }
};

exports.getGroupDetails = async (req, res) => {
    try {
        const userId = req.user.id;
        const user   = await User.findById(userId);

        if (!user.groupId) {
            return res.status(404).json({ message: "You are not in any group" });
        }

        let group = await Group.findById(user.groupId).populate("members", "name email");

        if (!group.joinCode) {
            group.joinCode = await generateUniqueJoinCode();
            await group.save();
        }

        res.json(group);
    } catch (error) {
        res.status(500).json({ message: "Server error fetching group details" });
    }
};

exports.getUserGroups = async (req, res) => {
    try {
        const userId = req.user.id;
        const groups = await Group.find({ members: userId });

        const fixedGroups = await Promise.all(groups.map(async (g) => {
            if (!g.joinCode) {
                g.joinCode = await generateUniqueJoinCode();
                await g.save();
            }
            return g;
        }));

        res.json(fixedGroups);
    } catch (error) {
        res.status(500).json({ message: "Server error fetching groups" });
    }
};

exports.switchActiveGroup = async (req, res) => {
    try {
        const { groupId } = req.body;
        const userId      = req.user.id;

        const group = await Group.findOne({ _id: groupId, members: userId });
        if (!group) return res.status(403).json({ message: "Access denied to this group" });

        await User.findByIdAndUpdate(userId, { groupId });
        res.json({ message: "Switched successfully", groupId });
    } catch (error) {
        res.status(500).json({ message: "Failed to switch group" });
    }
};

exports.addCategory = async (req, res) => {
    try {
        const { icon, type } = req.body;
        const rawName = req.body.name;
        if (!rawName || typeof rawName !== 'string') {
            return res.status(400).json({ message: "Category name is required" });
        }
        const name = rawName.trim().slice(0, 30);
        if (!name) return res.status(400).json({ message: "Category name cannot be empty" });

        const userId = req.user.id;
        const user   = await User.findById(userId);
        if (!user.groupId) return res.status(400).json({ message: "You are not in a group" });

        const group = await Group.findById(user.groupId);
        group.categories.push({ name, icon, type: type || 'expense' });
        await group.save();

        res.json(group.categories);
    } catch (error) {
        res.status(500).json({ message: "Failed to add category" });
    }
};

exports.removeCategory = async (req, res) => {
    try {
        const { categoryId } = req.params;
        const userId = req.user.id;
        const user   = await User.findById(userId);
        if (!user.groupId) return res.status(400).json({ message: "You are not in a group" });

        const group = await Group.findById(user.groupId);
        group.categories = group.categories.filter(c => c._id.toString() !== categoryId);
        await group.save();

        res.json(group.categories);
    } catch (error) {
        res.status(500).json({ message: "Failed to remove category" });
    }
};

exports.importCategories = async (req, res) => {
    try {
        const { fromGroupId, type } = req.body;
        const userId = req.user.id;
        const user   = await User.findById(userId);
        if (!user.groupId) return res.status(400).json({ message: "You are not in a group" });

        const fromGroup = await Group.findOne({ _id: fromGroupId, members: userId });
        if (!fromGroup) return res.status(403).json({ message: "Access denied to source group" });

        const targetGroup    = await Group.findById(user.groupId);
        const existingNames  = targetGroup.categories.map(c => c.name.toLowerCase());
        const newCategories  = fromGroup.categories.filter(c => {
            const isNew      = !existingNames.includes(c.name.toLowerCase());
            const catType    = c.type || 'expense';
            const typeMatches = !type || type === 'both' || catType === type;
            return isNew && typeMatches;
        });

        targetGroup.categories.push(...newCategories.map(c => ({ name: c.name, icon: c.icon, type: c.type || 'expense' })));
        await targetGroup.save();

        res.json(targetGroup.categories);
    } catch (error) {
        res.status(500).json({ message: "Failed to import categories" });
    }
};

exports.setupWeddingCategories = async (req, res) => {
    try {
        const userId = req.user.id;
        const user   = await User.findById(userId);
        if (!user.groupId) return res.status(400).json({ message: "You are not in a group" });

        const group = await Group.findById(user.groupId);

        const weddingCategories = [
            { name: "Catering (Jamvanu)",        icon: "restaurant",      type: "expense" },
            { name: "Venue (Wadi/Hall)",          icon: "business",        type: "expense" },
            { name: "Decoration",                 icon: "flower",          type: "expense" },
            { name: "Clothes",                    icon: "shirt",           type: "expense" },
            { name: "Jewellery",                  icon: "diamond",         type: "expense" },
            { name: "Gifts (Kariyavar/Saadu)",    icon: "gift",            type: "expense" },
            { name: "Music & Band",               icon: "musical-notes",   type: "expense" },
            { name: "Photography/Video",          icon: "camera",          type: "expense" },
            { name: "Invitations (Kankotri)",     icon: "mail-open",       type: "expense" },
            { name: "Transportation",             icon: "bus",             type: "expense" },
            { name: "Mehendi/Parlour",            icon: "color-palette",   type: "expense" },
            { name: "Other Wedding Expenses",     icon: "apps",            type: "expense" }
        ];

        const existingNames = group.categories.map(c => c.name.toLowerCase());
        group.categories.push(...weddingCategories.filter(c => !existingNames.includes(c.name.toLowerCase())));
        await group.save();

        res.json(group.categories);
    } catch (error) {
        res.status(500).json({ message: "Failed to setup wedding categories" });
    }
};
