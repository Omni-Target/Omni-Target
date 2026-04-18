export interface SpecificInterest {
  id: string;
  name?: string;
}

export interface GeoLocations {
  cities?: { key: string }[];
  countries?: string[];
}

export interface MetaTargetingSpec {
  optimization_goal: string;
  billing_event: string;
  targeting: {
    geo_locations: GeoLocations;
    behaviors: SpecificInterest[];
    interests: SpecificInterest[];
    custom_audiences?: SpecificInterest[];
    publisher_platforms?: string[];
    age_min?: number;
    age_max?: number;
  };
  warnings?: string[];
}

export function buildMetaTargeting(params: {
  audienceDescription: string;
  campaignGoal: string;
  locations: string[];
  platform: string;
  pixelHealth?: string;
}): MetaTargetingSpec {
  const { audienceDescription, campaignGoal, locations, platform, pixelHealth = "unknown" } = params;

  // Initial Spec Structure
  const spec: MetaTargetingSpec = {
    optimization_goal: "OFFSITE_CONVERSIONS",
    billing_event: "IMPRESSIONS",
    warnings: [],
    targeting: {
      geo_locations: {
        cities: [],
        countries: [],
      },
      interests: [],
      behaviors: [
        {
          id: "6002714895372",
          name: "Engaged Shoppers"
        },
        {
          id: "6004854404172",
          name: "Online Shoppers"
        }
      ],
    }
  };

  // Platform Mapping
  if (platform === "facebook") {
    spec.targeting.publisher_platforms = ["facebook"];
  } else if (platform === "instagram") {
    spec.targeting.publisher_platforms = ["instagram"];
  } else if (platform === "stories") {
    spec.targeting.publisher_platforms = ["facebook", "instagram"];
  } else {
    spec.targeting.publisher_platforms = ["facebook", "instagram"];
  }

  // LOCATION MAPPING
  locations.forEach(loc => {
    switch(loc) {
      case "Lagos":
        spec.targeting.geo_locations.cities?.push({ key: "2267057" });
        break;
      case "Abuja":
        spec.targeting.geo_locations.cities?.push({ key: "2344115" });
        break;
      case "Port Harcourt":
        spec.targeting.geo_locations.cities?.push({ key: "2343567" });
        break;
      case "All Nigeria":
        spec.targeting.geo_locations.countries?.push("NG");
        break;
      case "UK Diaspora":
        spec.targeting.geo_locations.countries?.push("GB");
        break;
      case "US Diaspora":
        spec.targeting.geo_locations.countries?.push("US");
        break;
      case "Global":
        break;
    }
  });

  // Clean empty geography arrays to avoid Meta API errors
  if (spec.targeting.geo_locations.cities?.length === 0) {
    delete spec.targeting.geo_locations.cities;
  }
  if (spec.targeting.geo_locations.countries?.length === 0) {
    delete spec.targeting.geo_locations.countries;
  }
  
  if (!spec.targeting.geo_locations.cities && !spec.targeting.geo_locations.countries) {
    // Fallback if none provided
    spec.targeting.geo_locations.countries = ["NG"];
  }

  // CAMPAIGN GOAL MAPPING
  switch (campaignGoal) {
    case "Drive Website Sales":
      spec.optimization_goal = "OFFSITE_CONVERSIONS";
      spec.billing_event = "IMPRESSIONS";
      // Engaged Shoppers is already included by default
      break;
    
    case "Grow Brand Awareness":
      spec.optimization_goal = "REACH";
      spec.billing_event = "IMPRESSIONS";
      // Remove age restrictions
      delete spec.targeting.age_min;
      delete spec.targeting.age_max;
      break;
    
    case "Promote a New Collection":
      spec.optimization_goal = "LINK_CLICKS";
      spec.billing_event = "LINK_CLICKS";
      // Add Fashion interest cluster
      spec.targeting.interests.push(
        { id: "6003107902433", name: "Fashion" },
        { id: "6004160395895", name: "Luxury goods" }
      );
      break;
    
    case "Retarget Past Visitors":
      spec.optimization_goal = "OFFSITE_CONVERSIONS";
      spec.billing_event = "IMPRESSIONS";
      spec.targeting.custom_audiences = [
        { id: "PIXEL_WEBSITE_VISITORS_PLACEHOLDER", name: "Website Visitors" }
      ];
      if (pixelHealth === "broken" || pixelHealth === "none") {
        spec.warnings?.push("Your Meta Pixel is not connected or verified. Retargeting will not perform accurately until pixel issues are resolved.");
      }
      break;
    
    case "Grow Instagram Following":
      spec.optimization_goal = "PAGE_LIKES";
      spec.billing_event = "IMPRESSIONS";
      spec.targeting.publisher_platforms = ["instagram"];
      break;
  }

  // INTEREST INFERENCE
  const descLower = audienceDescription.toLowerCase();

  // These are approximations — 
  // verify interest IDs in Meta 
  // Marketing API before production
  if (/(fashion|style|clothes|clothing|wear|brand)/.test(descLower)) {
    spec.targeting.interests.push(
      { id: "6003107902433", name: "Fashion" },
      { id: "6004160395895", name: "Luxury goods" }
    );
  }

  // These are approximations — 
  // verify interest IDs in Meta 
  // Marketing API before production
  if (/(young|under 30)/.test(descLower)) {
    spec.targeting.interests.push({ id: "6003139266461", name: "Streetwear" });
  }

  // These are approximations — 
  // verify interest IDs in Meta 
  // Marketing API before production
  if (/(professional|corporate)/.test(descLower)) {
    spec.targeting.interests.push({ id: "6003200145317", name: "Business professionals" });
  }

  // These are approximations — 
  // verify interest IDs in Meta 
  // Marketing API before production
  if (/(bride|wedding)/.test(descLower)) {
    spec.targeting.interests.push({ id: "6003283735711", name: "Wedding" });
  }

  // These are approximations — 
  // verify interest IDs in Meta 
  // Marketing API before production
  if (/(ankara|adire|african)/.test(descLower)) {
    spec.targeting.interests.push({ id: "6003384742467", name: "African fashion" });
  }

  // Deduplicate interests based on ID
  spec.targeting.interests = spec.targeting.interests.filter(
    (interest, index, self) =>
      index === self.findIndex((t) => t.id === interest.id)
  );

  return spec;
}
