const Group = require("../models/Group");
const User = require("../models/User");
const crypto = require("crypto");

exports.createGroup = async (req, res) => {
    try {
        const { groupName } = req.body;
        const userId = req.user.id;

        const joinCode = crypto.randomBytes(3).toString("hex").toUpperCase();

        const group = await Group.create({
            name: groupName,
            joinCode,
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
        const { inviteCode } = req.body; // Keeping key name for backward compatibility with frontend if needed
        const userId = req.user.id;

        const codeToFind = inviteCode || req.body.joinCode;

        if (!codeToFind) return res.status(400).json({ message: "Join code is required" });

        const group = await Group.findOne({ joinCode: codeToFind.trim().toUpperCase() });

        if (!group) return res.status(404).json({ message: "Invalid join code" });

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

        let group = await Group.findById(user.groupId).populate("members", "name email");
        
        // Auto-fix for legacy groups missing joinCode
        if (!group.joinCode) {
            group.joinCode = crypto.randomBytes(3).toString("hex").toUpperCase();
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
        
        // Ensure all returned groups have joinCode
        const fixedGroups = await Promise.all(groups.map(async (g) => {
            if (!g.joinCode) {
                g.joinCode = crypto.randomBytes(3).toString("hex").toUpperCase();
                await g.save();
            }
            return g;
        }));

        res.json(fixedGroups);
    } catch (error) {
        res.status(500).json({ message: "Server error fetching groups" });
    }
};

// ... Rest of the controllers (switchActiveGroup, addCategory, etc.) remain largely the same but ensure they use joinCode if needed ...
// I will include them for completeness in the file write.

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

exports.addCategory = async (req, res) => {
  try {
    const { name, icon, type } = req.body;
    const userId = req.user.id;
    const user = await User.findById(userId);
    
    if (!user.groupId) return res.status(400).json({ message: "User not in group" });

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
    const user = await User.findById(userId);

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
    const user = await User.findById(userId);

    const fromGroup = await Group.findOne({ _id: fromGroupId, members: userId });
    if (!fromGroup) return res.status(403).json({ message: "Access denied to source group" });

    const targetGroup = await Group.findById(user.groupId);
    
    const existingNames = targetGroup.categories.map(c => c.name.toLowerCase());
    const newCategories = fromGroup.categories.filter(c => {
        const isNew = !existingNames.includes(c.name.toLowerCase());
        const catType = c.type || 'expense';
        const typeMatches = !type || type === 'both' || catType === type;
        return isNew && typeMatches;
    });
    
    targetGroup.categories.push(...newCategories.map(c => ({ 
        name: c.name, 
        icon: c.icon,
        type: c.type || 'expense'
    })));
    await targetGroup.save();

    res.json(targetGroup.categories);
  } catch (error) {
    res.status(500).json({ message: "Failed to import categories" });
  }
};

exports.setupWeddingCategories = async (req, res) => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);
        const group = await Group.findById(user.groupId);

        const weddingCategories = [
            { name: "Catering (Jamvanu)", icon: "restaurant", type: "expense" },
            { name: "Venue (Wadi/Hall)", icon: "business", type: "expense" },
            { name: "Decoration", icon: "flower", type: "expense" },
            { name: "Clothes", icon: "shirt", type: "expense" },
            { name: "Jewellery", icon: "diamond", type: "expense" },
            { name: "Gifts (Kariyavar/Saadu)", icon: "gift", type: "expense" },
            { name: "Music & Band", icon: "musical-notes", type: "expense" },
            { name: "Photography/Video", icon: "camera", type: "expense" },
            { name: "Invitations (Kankotri)", icon: "mail-open", type: "expense" },
            { name: "Transportation", icon: "bus", type: "expense" },
            { name: "Mehendi/Parlour", icon: "color-palette", type: "expense" },
            { name: "Other Wedding Expenses", icon: "apps", type: "expense" }
        ];

        const existingNames = group.categories.map(c => c.name.toLowerCase());
        const filteredNew = weddingCategories.filter(c => !existingNames.includes(c.name.toLowerCase()));

        group.categories.push(...filteredNew);
        await group.save();

        res.json(group.categories);
    } catch (error) {
        res.status(500).json({ message: "Failed to setup wedding categories" });
    }
};