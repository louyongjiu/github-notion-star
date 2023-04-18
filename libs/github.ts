import { Octokit } from '@octokit/core';
import { QueryForStarredRepository, Repo, GithubRepositoryTopic, RepositoryTopic } from './types';
import * as retry from 'retry';


// @ts-ignore
const githubTopicsFirst = +process.env.REPO_TOPICS_LIMIT || 50;

export class Github {
    private client: Octokit;

    constructor() {
        this.client = new Octokit({
            auth: process.env.TOKEN_OF_GITHUB,
        });
    }

    repoList: Repo[] = [];

    async fullSync() {
        // @ts-ignore
        const limit = +process.env.FULLSYNC_LIMIT || 2000;
        console.log(`Github: Start to get all starred repos, limit is ${limit}`);

        let cursor = '';
        let hasNextPage = true;
        const repoList = [];
        let round = 1;

        while (hasNextPage && repoList.length < limit) {
            const data = await this.getStarredRepoAfterCursorRetryable(cursor, githubTopicsFirst);
            repoList.push(
                ...this.transformGithubStarResponse(data),
            );
            hasNextPage = data.starredRepositories.pageInfo.hasNextPage;
            cursor = data.starredRepositories.pageInfo.endCursor;
            console.log(`Github: Get starred repos, round is ${round}, count is ${repoList.length}, cursor is ${cursor}, hasNextPage is ${hasNextPage}`);
            round++;
        }

        this.repoList = repoList;

        console.log(`Github: Get all starred repos success, count is ${this.repoList.length}`);
    }

    async getList() {
        // @ts-ignore
        const limit = +process.env.PARTIALSYNC_LIMIT || 10;

        console.log(`Github: Start to sync latest starred repos, limit is ${limit}`);

        const data = await this.getLastStarredRepo(limit, githubTopicsFirst);
        this.repoList.push(
            ...this.transformGithubStarResponse(data),
        );
    }

    private transformGithubStarResponse(data: QueryForStarredRepository): Repo[] {
        return (data.starredRepositories.edges || []).map(({ node, starredAt }) => ({
            ...node,
            starredAt,
            repositoryTopics: (node?.repositoryTopics?.nodes || []).map(
                (o: GithubRepositoryTopic): RepositoryTopic => ({ name: o?.topic?.name })
            ),
        }))
    }

    private async getStarredRepoAfterCursorRetryable(cursor: string, topicFirst: number) {
        return new Promise<QueryForStarredRepository>((resolve, reject) => {
            const operation: retry.RetryOperation = retry.operation({ retries: 5, factor: 2, minTimeout: 120000 });
            operation.attempt(async (retryCount) => {
                try {
                    resolve(await this.getStarredRepoAfterCursor(cursor, topicFirst))
                } catch (err) {
                    if (operation.retry(err)) {
                        console.log(`retryCount ${retryCount} , error ${err}`);
                        // console.log(`Rate limited, retrying in ${operation.timeouts()} ms`);
                    } else {
                        reject(err);
                    }

                }
            });
        });
    }


    private async getStarredRepoAfterCursor(cursor: string, topicFirst: number) {
        const data = await this.client.graphql<{ viewer: QueryForStarredRepository }>(
            `
                query ($after: String, $topicFirst: Int) {
                    viewer {
                        starredRepositories(first: 100, after: $after) {
                            pageInfo {
                                startCursor
                                endCursor
                                hasNextPage
                            }
                            edges {
                                starredAt
                                node {
                                    nameWithOwner
                                    url
                                    description
                                    primaryLanguage {
                                        name
                                    }
                                    repositoryTopics(first: $topicFirst) {
                                        nodes {
                                            topic {
                                                name
                                            }
                                        }
                                    }
                                    updatedAt
                                    stargazerCount
                                }
                            }
                        }
                    }
                }
            `,
            {
                after: cursor,
                topicFirst: topicFirst,
            },
        );

        return data.viewer;
    }

    private async getLastStarredRepo(last: number, topicFirst: number) {
        const data = await this.client.graphql<{ viewer: QueryForStarredRepository }>(
            `
                query ($last: Int, $topicFirst: Int) {
                    viewer {
                        starredRepositories(last: $last) {
                            pageInfo {
                                startCursor
                                endCursor
                                hasNextPage
                            }
                            nodes {
                                nameWithOwner
                                url
                                description
                            }
                            edges {
                                starredAt
                                node {
                                    nameWithOwner
                                    url
                                    description
                                    primaryLanguage {
                                        name
                                    }
                                    repositoryTopics(first: $topicFirst) {
                                        nodes {
                                            topic {
                                                name
                                            }
                                        }
                                    }
                                    updatedAt
                                    stargazerCount
                                }
                            }
                        }
                    }
                }
            `,
            {
                last: last,
                topicFirst: topicFirst,
            },
        );

        return data.viewer;
    }
}

export const github = new Github();
