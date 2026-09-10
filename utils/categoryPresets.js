// Named packs of categories, so setting up for a wedding or a trip is one tap instead of typing
// twelve categories in one at a time.
//
// This started as `setupWeddingCategories`, a single hardcoded list on its own route that no screen
// in the app ever called. The list is kept verbatim under the `wedding` key — it is the one someone
// may already have applied by hand against the old endpoint, and its Gujarati glosses are the point
// of it.

const PRESETS = {
  wedding: {
    name:        "Wedding",
    description: "Catering, venue, clothes and everything else a wedding runs up",
    icon:        "heart",
    categories: [
      { name: "Catering (Jamvanu)",     icon: "restaurant",    emoji: "🍽️", type: "expense" },
      { name: "Venue (Wadi/Hall)",      icon: "business",      emoji: "🏛️", type: "expense" },
      { name: "Decoration",             icon: "flower",        emoji: "💐", type: "expense" },
      { name: "Clothes",                icon: "shirt",         emoji: "👗", type: "expense" },
      { name: "Jewellery",              icon: "diamond",       emoji: "💍", type: "expense" },
      { name: "Gifts (Kariyavar/Saadu)",icon: "gift",          emoji: "🎁", type: "expense" },
      { name: "Music & Band",           icon: "musical-notes", emoji: "🎶", type: "expense" },
      { name: "Photography/Video",      icon: "camera",        emoji: "📸", type: "expense" },
      { name: "Invitations (Kankotri)", icon: "mail-open",     emoji: "💌", type: "expense" },
      { name: "Transportation",         icon: "bus",           emoji: "🚌", type: "expense" },
      { name: "Mehendi/Parlour",        icon: "color-palette", emoji: "💅", type: "expense" },
      { name: "Other Wedding Expenses", icon: "apps",          emoji: "📦", type: "expense" },
    ],
  },

  household: {
    name:        "Household",
    description: "Running a home — bills, repairs, help and groceries",
    icon:        "home",
    categories: [
      { name: "Groceries",       icon: "basket",       emoji: "🛒", type: "expense" },
      { name: "Electricity",     icon: "flash",        emoji: "💡", type: "expense" },
      { name: "Water",           icon: "water",        emoji: "🚿", type: "expense" },
      { name: "Gas Cylinder",    icon: "flame",        emoji: "🔥", type: "expense" },
      { name: "Internet & Mobile", icon: "wifi",       emoji: "📶", type: "expense" },
      { name: "Maintenance",     icon: "construct",    emoji: "🔧", type: "expense" },
      { name: "Househelp",       icon: "people",       emoji: "🧹", type: "expense" },
      { name: "Repairs",         icon: "hammer",       emoji: "🛠️", type: "expense" },
    ],
  },

  travel: {
    name:        "Travel",
    description: "A trip, from tickets to souvenirs",
    icon:        "airplane",
    categories: [
      { name: "Flights",       icon: "airplane",  emoji: "✈️", type: "expense" },
      { name: "Trains & Buses",icon: "train",     emoji: "🚆", type: "expense" },
      { name: "Stay",          icon: "bed",       emoji: "🏨", type: "expense" },
      { name: "Local Transport", icon: "car-sport", emoji: "🚕", type: "expense" },
      { name: "Eating Out",    icon: "restaurant",emoji: "🍜", type: "expense" },
      { name: "Sightseeing",   icon: "camera",    emoji: "🗺️", type: "expense" },
      { name: "Souvenirs",     icon: "bag-handle",emoji: "🧳", type: "expense" },
      { name: "Visa & Insurance", icon: "document-text", emoji: "📄", type: "expense" },
    ],
  },

  business: {
    name:        "Business & Freelance",
    description: "Client work — what comes in and what it costs to earn it",
    icon:        "briefcase",
    categories: [
      { name: "Client Payment",   icon: "cash",         emoji: "💰", type: "income"  },
      { name: "Retainer",         icon: "repeat",       emoji: "🔁", type: "income"  },
      { name: "Software & Tools", icon: "laptop",       emoji: "💻", type: "expense" },
      { name: "Subcontractors",   icon: "people",       emoji: "👥", type: "expense" },
      { name: "Office & Coworking", icon: "business",   emoji: "🏢", type: "expense" },
      { name: "Marketing",        icon: "megaphone",    emoji: "📣", type: "expense" },
      { name: "Professional Fees",icon: "document-text",emoji: "🧾", type: "expense" },
      { name: "Taxes",            icon: "receipt",      emoji: "🏛️", type: "expense" },
    ],
  },

  vehicle: {
    name:        "Vehicle",
    description: "Fuel, servicing and everything a car or bike asks for",
    icon:        "car",
    categories: [
      { name: "Fuel",         icon: "speedometer", emoji: "⛽", type: "expense" },
      { name: "Servicing",    icon: "construct",   emoji: "🔧", type: "expense" },
      { name: "Insurance",    icon: "shield",      emoji: "🛡️", type: "expense" },
      { name: "Parking & Tolls", icon: "pricetag", emoji: "🅿️", type: "expense" },
      { name: "Fines",        icon: "warning",     emoji: "🚨", type: "expense" },
      { name: "EMI",          icon: "card",        emoji: "💳", type: "expense" },
    ],
  },

  baby: {
    name:        "Baby & Kids",
    description: "The first few years, and school after that",
    icon:        "happy",
    categories: [
      { name: "Diapers & Wipes", icon: "cube",     emoji: "🧷", type: "expense" },
      { name: "Baby Food",       icon: "nutrition",emoji: "🍼", type: "expense" },
      { name: "Clothes & Toys",  icon: "balloon",  emoji: "🧸", type: "expense" },
      { name: "Doctor & Vaccines", icon: "medical",emoji: "💉", type: "expense" },
      { name: "Childcare",       icon: "people",   emoji: "🧑‍🍼", type: "expense" },
      { name: "School Fees",     icon: "school",   emoji: "🎒", type: "expense" },
    ],
  },

  student: {
    name:        "Student",
    description: "Fees, books, rent and the rest of a term",
    icon:        "school",
    categories: [
      { name: "Tuition Fees",  icon: "school",     emoji: "🎓", type: "expense" },
      { name: "Books & Supplies", icon: "book",    emoji: "📚", type: "expense" },
      { name: "Hostel & Rent", icon: "home",       emoji: "🏠", type: "expense" },
      { name: "Mess & Canteen",icon: "fast-food",  emoji: "🍱", type: "expense" },
      { name: "Coaching",      icon: "easel",      emoji: "🧑‍🏫", type: "expense" },
      { name: "Scholarship",   icon: "ribbon",     emoji: "🏅", type: "income"  },
      { name: "Part-time Work",icon: "briefcase",  emoji: "💼", type: "income"  },
    ],
  },
};

/** The catalogue as the app lists it — everything except the category rows themselves. */
function listPresets() {
  return Object.entries(PRESETS).map(([key, p]) => ({
    key, name: p.name, description: p.description, icon: p.icon, count: p.categories.length,
  }));
}

/**
 * The rows from `key` that `existing` does not already have, matched on name case-insensitively.
 * Applying a preset twice, or two presets that overlap, must not duplicate anything.
 */
function newCategoriesFor(key, existing) {
  const preset = PRESETS[key];
  if (!preset) return null;

  const have = new Set(existing.map(c => c.name.trim().toLowerCase()));
  return preset.categories.filter(c => !have.has(c.name.toLowerCase()));
}

module.exports = { PRESETS, listPresets, newCategoriesFor };
