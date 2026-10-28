"use client";

import ApplicationsTab from "./ApplicationsTab";
import JobsTab from "./JobsTab";
import ProfileTab from "./ProfileTab";
import { ProjectBar } from "./ProjectBar";
import ShowcaseTab from "./ShowcaseTab";
import VariantsTab from "./VariantsTab";
import WebsiteTab from "@/tools/site/WebsiteTab";

/**
 * Every CV studio tab under the CV project bar (switcher + "How this works"): the registry maps the cv-* components here
 * (src/tools/registry-client.tsx), which loads this module lazily (its "Loading tool…" status covers every tab).
 */

export function CvProfile() {
  return (
    <>
      <ProjectBar tab="profile" />
      <ProfileTab />
    </>
  );
}

export function CvJobs() {
  return (
    <>
      <ProjectBar tab="jobs" />
      <JobsTab />
    </>
  );
}

export function CvVariants() {
  return (
    <>
      <ProjectBar tab="variants" />
      <VariantsTab />
    </>
  );
}

export function CvApplications() {
  return (
    <>
      <ProjectBar tab="applications" />
      <ApplicationsTab />
    </>
  );
}

export function CvShowcase() {
  return (
    <>
      <ProjectBar tab="showcase" />
      <ShowcaseTab />
    </>
  );
}

export function CvWebsite() {
  return (
    <>
      <ProjectBar tab="website" />
      <WebsiteTab />
    </>
  );
}
