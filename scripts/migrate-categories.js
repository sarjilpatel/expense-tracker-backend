require('dotenv').config();
const mongoose = require('mongoose');
const Group = require('../models/Group');

const incomeCategories = [
  { name: "Salary", icon: "cash", type: "income" },
  { name: "Business", icon: "briefcase", type: "income" },
  { name: "Investment", icon: "trending-up", type: "income" },
  { name: "Gift", icon: "gift", type: "income" }
];

const migrate = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB...');

        const groups = await Group.find({});
        console.log(`Found ${groups.length} groups to update.`);

        for (const group of groups) {
            // Update existing categories to have 'expense' type if missing
            group.categories.forEach(cat => {
                if (!cat.type) cat.type = 'expense';
            });

            // Add income categories if they don't exist
            for (const incCat of incomeCategories) {
                if (!group.categories.find(c => c.name === incCat.name)) {
                    group.categories.push(incCat);
                }
            }
            
            // Ensure 'Other' is 'both'
            const other = group.categories.find(c => c.name === 'Other');
            if (other) other.type = 'both';

            await group.save();
        }

        console.log('Migration complete!');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
};

migrate();
