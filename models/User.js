const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    groupId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Group",
        default: null
    }
});

module.exports = mongoose.model("User", userSchema);