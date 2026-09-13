const Group = require("../models/Group");
const User = require("../models/User");
const { resolveActiveGroup, generateUniqueJoinCode } = require("../utils/personalGroup");
const { listPresets, newCategoriesFor }              = require("../utils/categoryPresets");
const { activeCategories }                           = require("../utils/categories");

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

        // isPersonal stays false: this is a group the user means to share, which is what gives it a
        // join code and a member list. Their personal group is left alone — they can switch back to
        // it from the group list, and the categories they built up there can be imported across.
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

        // Switch the approved user into the group they asked to join. The old condition here was
        // `!approvedUser.groupId`, which stopped being true the moment every account got a personal
        // group — an approved member would have been added to `members` and then left sitting in
        // their own space. Someone already in another *shared* group keeps it and switches by hand.
        const approvedUser = await User.findById(userId).populate("groupId", "isPersonal");
        const inPersonal   = !approvedUser?.groupId || approvedUser.groupId.isPersonal;
        if (approvedUser && inPersonal && String(approvedUser.groupId?._id) !== String(group._id)) {
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

        // Never 404 any more. This endpoint is the app's category source for six screens, and a
        // user with no group used to get "You are not in any group" from all of them; now they get
        // their personal group, created here if this is the first time anything asked for it.
        const active = await resolveActiveGroup(user);
        const group  = await Group.findById(active._id).populate("members", "name email");

        // A personal group is not joinable, so it deliberately has no code to hand out.
        if (!group.joinCode && !group.isPersonal) {
            group.joinCode = await generateUniqueJoinCode();
            await group.save();
        }

        // Tombstoned categories stay in the document for the sync feed; the app never sees them.
        const out = group.toObject();
        out.categories = activeCategories(group);
        res.json(out);
    } catch (error) {
        res.status(500).json({ message: "Server error fetching group details" });
    }
};

exports.getUserGroups = async (req, res) => {
    try {
        const userId = req.user.id;
        const groups = await Group.find({ members: userId });

        // Backfills a missing code, except on a personal group — that one has none on purpose, and
        // giving it one would make someone's own space joinable by anyone holding the code.
        const fixedGroups = await Promise.all(groups.map(async (g) => {
            if (!g.joinCode && !g.isPersonal) {
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
        const { icon, type, emoji } = req.body;
        const rawName = req.body.name;
        if (!rawName || typeof rawName !== 'string') {
            return res.status(400).json({ message: "Category name is required" });
        }
        const name = rawName.trim().slice(0, 30);
        if (!name) return res.status(400).json({ message: "Category name cannot be empty" });

        const userId = req.user.id;
        const user   = await User.findById(userId);
        const group  = await resolveActiveGroup(user);

        // Names are what transactions reference, and addTransaction validates against this list —
        // two categories with the same name would make that check ambiguous.
        if (activeCategories(group).some(c => c.name.trim().toLowerCase() === name.toLowerCase())) {
            return res.status(400).json({ message: "That category already exists" });
        }

        // A removed category of the same name comes back as itself rather than as a second row.
        const buried = group.categories.find(c => c.deletedAt && c.name.trim().toLowerCase() === name.toLowerCase());
        if (buried) {
            buried.set({ icon, emoji: emoji || "", type: type || 'expense', deletedAt: null });
        } else {
            group.categories.push({ name, icon, emoji: emoji || "", type: type || 'expense' });
        }
        await group.save();

        res.json(activeCategories(group));
    } catch (error) {
        res.status(500).json({ message: "Failed to add category" });
    }
};

exports.removeCategory = async (req, res) => {
    try {
        const { categoryId } = req.params;
        const userId = req.user.id;
        const user   = await User.findById(userId);
        const group  = await resolveActiveGroup(user);

        // Tombstone, not removal (W3-05): the sync feed has to be able to tell other devices.
        const cat = group.categories.find(c => c._id.toString() === categoryId && !c.deletedAt);
        if (cat) {
            cat.deletedAt = new Date();
            await group.save();
        }

        res.json(activeCategories(group));
    } catch (error) {
        res.status(500).json({ message: "Failed to remove category" });
    }
};

// The catalogue itself is static, but it sits behind auth like the rest of /api/group.
exports.getCategoryPresets = async (req, res) => {
    res.json(listPresets());
};

// Adds a named pack in one call. Idempotent by name, so applying the same preset twice — or two
// packs that overlap — adds nothing the group already has.
exports.applyCategoryPreset = async (req, res) => {
    try {
        const key    = req.params.key || req.body.preset;
        const userId = req.user.id;
        const user   = await User.findById(userId);
        const group  = await resolveActiveGroup(user);

        const additions = newCategoriesFor(key, activeCategories(group));
        if (additions === null) return res.status(404).json({ message: "Unknown category preset" });

        if (additions.length) {
            group.categories.push(...additions);
            await group.save();
        }

        res.json({ categories: activeCategories(group), added: additions.length });
    } catch (error) {
        res.status(500).json({ message: "Failed to apply category preset" });
    }
};

exports.importCategories = async (req, res) => {
    try {
        const { fromGroupId, type } = req.body;
        const userId = req.user.id;
        const user   = await User.findById(userId);

        const fromGroup = await Group.findOne({ _id: fromGroupId, members: userId });
        if (!fromGroup) return res.status(403).json({ message: "Access denied to source group" });

        // This is now also how someone carries the categories they built up on their own into a
        // shared group after joining one — the personal group is a valid source like any other.
        const targetGroup    = await resolveActiveGroup(user);
        if (String(targetGroup._id) === String(fromGroup._id)) {
            return res.status(400).json({ message: "That is the group you are importing into" });
        }
        const existingNames  = activeCategories(targetGroup).map(c => c.name.toLowerCase());
        const newCategories  = activeCategories(fromGroup).filter(c => {
            const isNew      = !existingNames.includes(c.name.toLowerCase());
            const catType    = c.type || 'expense';
            const typeMatches = !type || type === 'both' || catType === type;
            return isNew && typeMatches;
        });

        targetGroup.categories.push(...newCategories.map(c => ({
            name: c.name, icon: c.icon, emoji: c.emoji || "", type: c.type || 'expense',
        })));
        await targetGroup.save();

        res.json(activeCategories(targetGroup));
    } catch (error) {
        res.status(500).json({ message: "Failed to import categories" });
    }
};

// Kept so an older build of the app keeps working: the wedding list is now one preset among
// several, and this is just that preset under its original route.
exports.setupWeddingCategories = async (req, res) => {
    req.params.key = "wedding";
    return exports.applyCategoryPreset(req, res);
};
