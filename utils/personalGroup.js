const crypto      = require("crypto");
const Group       = require("../models/Group");
const User        = require("../models/User");
const Transaction = require("../models/Transaction");
const Goal        = require("../models/Goal");

// Categories live on the Group, and signup used to leave `groupId` null — so a fresh account had
// nowhere for them to live at all: /group/details answered 404 "You are not in any group", the
// category screens came up empty, adding one 400'd, and add-transaction had nothing to offer.
//
// Rather than give categories a second home on the User, every account now owns a personal group.
// It is a real group so that categories, scoping and validation have one code path instead of two,
// but `isPersonal` marks it as not shareable: it gets no join code, and the app keeps offering
// "create or join a group" to someone whose only group is this one.

async function generateUniqueJoinCode() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = crypto.randomBytes(3).toString("hex").toUpperCase();
        const existing = await Group.findOne({ joinCode: code });
        if (!existing) return code;
    }
    throw new Error("Failed to generate unique join code after 5 attempts");
}

/**
 * The user's personal group, created on first need. Returns it either way.
 *
 * `setActive` decides whether the user is also switched into it, which is only right when they
 * have no active group at all — someone who is in a shared group must stay there.
 *
 * Created without `categories` so the Group model's defaults apply; that list is the one every new
 * account starts with.
 */
async function ensurePersonalGroup(user, { setActive = true } = {}) {
    let group = await Group.findOne({ owner: user._id, isPersonal: true });

    if (!group) {
        group = await Group.create({
            name:       "Personal",
            isPersonal: true,
            joinCode:   null,          // deliberately none — a personal group cannot be joined
            owner:      user._id,
            members:    [user._id],
        });

        // The one thing that must not be forgotten. Everything this user wrote before personal
        // groups existed carries `groupId: null`, and `buildScope` switches them from userId-scope
        // to groupId-scope the moment they have a group — so without this their entire history
        // disappears from the app the first time they log in. Doing it here rather than only in the
        // migration script is what makes the lazy heal on login safe to run at all.
        //
        // Budgets and accounts are userId-scoped and need nothing. Trips already require a group.
        await Promise.all([
            Transaction.updateMany({ userId: user._id, groupId: null }, { groupId: group._id }),
            Goal.updateMany({ userId: user._id, groupId: null }, { groupId: group._id }),
        ]);
    }

    if (setActive && !user.groupId) {
        await User.findByIdAndUpdate(user._id, { groupId: group._id });
        user.groupId = group._id;      // callers go on to read this off the in-memory doc
    }

    return group;
}

/**
 * The group whose categories and scope apply to `user` right now, creating the personal one if they
 * somehow have none. This is the backstop for accounts that predate personal groups and for any
 * path that creates a user without going through signup.
 */
async function resolveActiveGroup(user) {
    if (user.groupId) {
        const active = await Group.findById(user.groupId);
        if (active) return active;
        // A dangling groupId — the group was deleted out from under them. Fall through and heal.
        user.groupId = null;
    }
    return ensurePersonalGroup(user);
}

module.exports = { ensurePersonalGroup, resolveActiveGroup, generateUniqueJoinCode };
