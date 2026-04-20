const { default: mongoose } = require("mongoose");

const groupSchema = new mongoose.Schema({
    name: String,
    inviteCode: String,
    members: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    }]
});

module.exports = mongoose.model("Group", groupSchema);