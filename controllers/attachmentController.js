const mongoose    = require('mongoose');
const { GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const Transaction = require('../models/Transaction');
const Group       = require('../models/Group');
const { s3Client } = require('../middleware/uploadMiddleware');

/**
 * Receipts (W3-24). A receipt is a file on the device that belongs to one transaction; the sync
 * engine uploads it here after the transaction itself has landed, and the row then carries
 * `receiptKey` so any device that pulls it knows there is something to fetch — on demand, through
 * the signed URL below, never eagerly (a year of receipts is hundreds of MB).
 *
 * The transaction is addressed by its clientId, like everything on the sync path.
 */

const isObjectId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v);

/** The caller's own transaction by clientId (or _id for a pre-sync row). */
async function ownTransaction(userId, clientId) {
  const byClient = await Transaction.findOne({ userId, clientId, deletedAt: null });
  if (byClient) return byClient;
  return isObjectId(clientId) ? Transaction.findOne({ userId, _id: clientId, deletedAt: null }) : null;
}

/** A transaction the caller may *see*: their own, or a non-private one in a group they belong to. */
async function visibleTransaction(userId, clientId) {
  const groups = await Group.find({ members: userId }, { _id: 1 });
  const groupIds = groups.map((g) => g._id);
  const scope = { deletedAt: null, $or: [{ userId }, { groupId: { $in: groupIds }, isPrivate: { $ne: true } }] };
  const byClient = await Transaction.findOne({ ...scope, clientId });
  if (byClient) return byClient;
  return isObjectId(clientId) ? Transaction.findOne({ ...scope, _id: clientId }) : null;
}

async function deleteObject(key) {
  if (!key) return;
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: key }));
  } catch (e) {
    console.error('[attachments] could not delete', key, e.message);
  }
}

// @route POST /api/attachments/receipts/:clientId   (multipart, field `file`)
exports.uploadReceipt = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file' });
  const tx = await ownTransaction(req.user.id, req.params.clientId);
  if (!tx) {
    // The transaction has not landed yet (or is not the caller's). The object is already in
    // S3 — take it back out so a failed push cannot leak storage.
    await deleteObject(req.file.key);
    return res.status(404).json({ message: 'Transaction not found' });
  }
  const previous = tx.receiptKey;
  tx.receiptKey = req.file.key;
  await tx.save();               // bumps updatedAt/syncedAt: other devices hear about it
  if (previous && previous !== req.file.key) await deleteObject(previous);
  res.json({ receiptKey: tx.receiptKey });
};

// @route GET /api/attachments/receipts/:clientId/url
exports.receiptUrl = async (req, res) => {
  const tx = await visibleTransaction(req.user.id, req.params.clientId);
  if (!tx) return res.status(404).json({ message: 'Transaction not found' });
  if (!tx.receiptKey) return res.json({ url: null });
  const command = new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME, Key: tx.receiptKey });
  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  res.json({ url, receiptKey: tx.receiptKey });
};

// @route DELETE /api/attachments/receipts/:clientId
exports.deleteReceipt = async (req, res) => {
  const tx = await ownTransaction(req.user.id, req.params.clientId);
  if (!tx) return res.status(404).json({ message: 'Transaction not found' });
  const key = tx.receiptKey;
  if (key) {
    tx.receiptKey = null;
    await tx.save();
    await deleteObject(key);
  }
  res.json({ receiptKey: null });
};
