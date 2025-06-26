// @ts-check
import semverInc from "semver/functions/inc.js";
import { Config, octokit } from "./shared.js";
import { Result } from "./types.js";
import { createExplainComment, truncatePrDescription } from "./utils.js";

export async function createReleasePR(): Promise<Result> {
  const isDryRun = Config.isDryRun;
  const isHotfix = Config.releaseType === "hotfix";

  // For hotfix, create branch from main_branch; for release, create from develop_branch
  const sourceBranch = isHotfix ? Config.prodBranch : Config.developBranch;
  const branchPrefix = isHotfix ? Config.hotfixBranchPrefix : Config.releaseBranchPrefix;

  const sourceBranchSha = (
    await octokit.rest.repos.getBranch({
      ...Config.repo,
      branch: sourceBranch,
    })
  ).data.commit.sha;

  console.log(
    `create_release: Generating ${Config.releaseType} notes for ${sourceBranchSha} from ${sourceBranch}`,
  );



  const { data: latestRelease } = await octokit.rest.repos
    .getLatestRelease(Config.repo)
    .catch(() => ({ data: null }));

  const latest_release_tag_name = latestRelease?.tag_name;

  let version: string;
  if (Config.version) {
    version = Config.version;
  } else if (Config.versionIncrement) {
    const increasedVersion = semverInc(
      latest_release_tag_name || "0.0.0",
      Config.versionIncrement,
      { loose: true },
    );
    if (!increasedVersion) {
      throw new Error(
        `create_release: Could not increment version ${latest_release_tag_name} with ${Config.versionIncrement}`,
      );
    }
    version = increasedVersion;
  } else {
    version = sourceBranchSha;
  }

  // For release notes, we want to compare against the appropriate base
  // For hotfix: compare from main to main (will show commits since last release)
  // For release: compare from develop to develop (will show all new commits)
  const releaseNotesBase = isHotfix ? Config.prodBranch : Config.developBranch;
  
  const { data: releaseNotes } = await octokit.rest.repos.generateReleaseNotes({
    ...Config.repo,
    tag_name: version,
    target_commitish: releaseNotesBase,
    previous_tag_name: latest_release_tag_name,
  });

  const releasePrBody = `${releaseNotes.body}
    
## Release summary

${Config.releaseSummary}
  `;

  // Truncate the PR body if it exceeds GitHub's character limit
  const truncatedReleasePrBody = truncatePrDescription(releasePrBody);

  const releaseBranch = `${branchPrefix}${version}`;
  let pull_number;

  if (!isDryRun) {
    console.log(`create_release: Creating ${Config.releaseType} branch ${releaseBranch} from ${sourceBranch}`);

    // create release/hotfix branch from latest sha of source branch
    await octokit.rest.git.createRef({
      ...Config.repo,
      ref: `refs/heads/${releaseBranch}`,
      sha: sourceBranchSha,
    });

    console.log(`create_release: Creating Pull Request`);

    const prTitle = isHotfix 
      ? `HOTFIX: ${releaseNotes.name || version}`
      : `RELEASE: ${releaseNotes.name || version}`;

    const { data: pullRequest } = await octokit.rest.pulls.create({
      ...Config.repo,
      title: prTitle,
      body: truncatedReleasePrBody,
      head: releaseBranch,
      base: Config.prodBranch,
      maintainer_can_modify: false,
    });

    pull_number = pullRequest.number;

    await octokit.rest.issues.addLabels({
      ...Config.repo,
      issue_number: pullRequest.number,
      labels: [Config.releaseType],
    });

    await createExplainComment(pullRequest.number);

    console.log(
      `create_release: Pull request has been created at ${pullRequest.html_url}`,
    );
  } else {
    console.log(
      `create_release: Dry run: would have created ${Config.releaseType} branch ${releaseBranch} from ${sourceBranch} and PR with body:\n${truncatedReleasePrBody}`,
    );
  }

  // Parse the PR body for PR numbers
  let mergedPrNumbers = (releaseNotes.body.match(/pull\/\d+/g) || []).map(
    (prNumber) => Number(prNumber.replace("pull/", "")),
  );
  // remove duplicates due to the "New contributors" section
  mergedPrNumbers = Array.from(new Set(mergedPrNumbers)).sort();

  return {
    type: isHotfix ? "hotfix" : "release",
    pull_number: pull_number,
    pull_numbers_in_release: mergedPrNumbers.join(","),
    version,
    release_branch: releaseBranch,
    latest_release_tag_name,
  };
}
