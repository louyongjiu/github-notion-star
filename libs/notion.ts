import { Client } from '@notionhq/client';
import { NotionPage, Repo } from './types';
import { QueryDatabaseResponse, CreatePageResponse } from '@notionhq/client/build/src/api-endpoints';
import { get, save } from './cache';
import _ from 'lodash';
import * as retry from 'retry';


// TODO: add assertion
const databaseId = process.env.NOTION_DATABASE_ID as string;

const NAMESPACE = 'notion-page';
// @ts-ignore
const OPERATION_BATCH_SIZE = +process.env.OPERATION_BATCH_SIZE || 5

export class Notion {
    private notion: Client;

    constructor() {
        this.notion = new Client({
            auth: process.env.NOTION_API_KEY,
        });

        this.pages = get(NAMESPACE, {});

        console.log(`Notion: restored from cache, count is ${Object.keys(this.pages).length}`);
    }

    save() {
        save(NAMESPACE, this.pages);
    }

    pages: Record<string, { id: string }> = {};

    hasPage(name: string) {
        return !!this.pages[name];
    }

    /**
     * full-sync pages in database
     */
    async fullSyncIfNeeded() {
        if (Object.keys(this.pages).length) {
            console.log(`Notion: skipped sync due to cache`);
            return;
        }

        console.log('Notion: Start to get all pages');

        let hasNext = true;
        let cursor: string | undefined = undefined;
        let round = 1;

        while (hasNext) {
            const database: QueryDatabaseResponse = await this.getPagesRetryable(cursor);

            this.addPages(database.results as NotionPage[]);
            hasNext = database.has_more;
            // @ts-ignore
            cursor = database.next_cursor;
            console.log(`Notion: Get pages, round is ${round}, count is ${Object.keys(this.pages).length}, cursor is ${cursor}, hasNext is ${hasNext}`);
            round++;
        }

        console.log(`Notion: Get all pages success, count is ${Object.keys(this.pages).length}`);

        this.save();
    }

    private async getPagesRetryable(cursor: string | undefined) {
        return new Promise<QueryDatabaseResponse>((resolve, reject) => {
            const operation: retry.RetryOperation = retry.operation({ retries: 5, factor: 2, minTimeout: 5000 });
            operation.attempt(async (retryCount) => {
                try {
                    resolve(await this.getPages(cursor))
                } catch (err) {
                    if (operation.retry(err)) {
                        console.log(`Notion: retryCount ${retryCount} , error ${JSON.stringify(err)}`);
                        // console.log(`Rate limited, retrying in ${operation.timeouts()} ms`);
                    } else {
                        reject(err);
                    }

                }
            });
        });
    }


    private async getPages(cursor: string | undefined){
        const database: QueryDatabaseResponse = await this.notion.databases.query({
            database_id: databaseId,
            page_size: 100,
            start_cursor: cursor,
        });
        return database;
    }


    addPages(pages: NotionPage[]) {
        pages.forEach((page) => {
            this.pages[page.properties.Name.title[0].plain_text] = {
                id: page.id,
            };
        });

        this.save();
    }

    async createPages(repoList: Repo[]) {
        const repoChunks = _.chunk(repoList, OPERATION_BATCH_SIZE)
        for (const repoBatch of repoChunks) {
            await Promise.all(
                repoBatch.map((repo: Repo) =>
                    this.createPage(repo)
                )
            )
        }
    }

    async createPage(repo: Repo) {
        if (!this.hasPage(repo.nameWithOwner)) {
            await this.insertPage(repo)
        }
    }

    async insertPage(repo: Repo) {
        const data = await this.insertNotionPageRetryable(repo);

        this.pages[repo.nameWithOwner] = { id: data.id };

        console.log(`insert page ${repo.nameWithOwner} success, page id is ${data.id}`);

        this.save();
    }

    
    private async insertNotionPageRetryable(repo: Repo) {
        return new Promise<CreatePageResponse>((resolve, reject) => {
            const operation: retry.RetryOperation = retry.operation({ retries: 5, factor: 2, minTimeout: 10000 });
            operation.attempt(async (retryCount) => {
                try {
                    resolve(await this.insertNotionPage(repo))
                } catch (err) {
                    if (operation.retry(err)) {
                        console.log(`Notion: insert page ${repo.nameWithOwner} fail , retryCount ${retryCount}`);
                        // console.log(`Rate limited, retrying in ${operation.timeouts()} ms`);
                    } else {
                        reject(err);
                    }

                }
            });
        });
    }

    private async insertNotionPage(repo: Repo) {
        return await this.notion.pages.create({
            parent: {
                database_id: databaseId,
            },
            properties: {
                Name: {
                    type: 'title',
                    title: [
                        {
                            type: 'text',
                            text: {
                                content: repo.nameWithOwner,
                            },
                        },
                    ],
                },
                // Type: {
                //     type: 'select',
                //     select: {
                //         name: 'Star',
                //     },
                // },
                Link: {
                    type: 'url',
                    url: repo.url,
                },
                Description: {
                    type: 'rich_text',
                    rich_text: [
                        {
                            type: 'text',
                            text: {
                                content: repo.description && repo.description.length >= 2000
                                    ? repo.description.slice(0, 1997) + "..."
                                    : repo.description || "",
                            },
                        },
                    ],
                },
                'Primary Language': {
                    type: 'rich_text',
                    rich_text: [
                        {
                            type: 'text',
                            text: {
                                content: repo?.primaryLanguage?.name || '',
                            },
                        }]
                },
                'Repository Topics': {
                    type: 'rich_text',
                    rich_text: [
                        {
                            type: 'text',
                            text: {
                                content: repo.repositoryTopics ? repo.repositoryTopics.map((topic) => topic.name).join(',') : '',
                            },
                        }]
                },
                'Starred At': {
                    type: 'date',
                    date: {
                        start: repo.starredAt,
                        end: repo.starredAt,
                    },
                },
                'Stargazers': {
                    type: 'number',
                    number: repo.stargazerCount,
                },
            },
        });

    }
}

export const notion = new Notion();
