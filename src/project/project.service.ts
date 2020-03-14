import * as pgp from 'pg-promise';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Serializer } from 'jsonapi-serializer';
import { Query } from '@nestjs/common';
import { paginate, Pagination, IPaginationOptions } from 'nestjs-typeorm-paginate';
import { Request } from 'express';
import { dasherize } from 'inflected';
import { getVideoLinks } from './_utils/get-video-links';
import { injectSupportDocumentURLs } from './_utils/inject-supporting-document-urls';
import { bbox, buffer, point } from '@turf/turf';
import { ConfigService } from '../config/config.service';
import { TilesService } from './tiles/tiles.service';
import { getQueryFile } from '../_utils/get-query-file';
import { handleDownload } from './_utils/handle-download';
import { buildProjectsSQL } from './_utils/build-projects-sql';
import { transformMilestones } from './_utils/transform-milestones';
import { transformActions } from './_utils/transform-actions';
import { transformProjects } from './_utils/transform-projects';
import { Project, KEYS as PROJECT_KEYS, ACTION_KEYS, MILESTONE_KEYS } from './project.entity';
import { KEYS as DISPOSITION_KEYS } from '../disposition/disposition.entity';
import { Octokit } from '@octokit/rest';
import { OdataService, overwriteCodesWithLabels } from '../odata/odata.service';
import * as jwt from 'jsonwebtoken';

const ITEMS_PER_PAGE = 30;
const BOROUGH_LOOKUP = {
  Bronx: 717170000,
  Brooklyn: 717170002,
  Manhattan: 717170001,
  Queens: 717170003,
  'Staten Island': 717170004,
  Citywide: 717170005,
};
const ULURP_LOOKUP = {
  'Non-ULURP': 717170000,
  'ULURP': 717170001,
};
const PROJECT_STATUS_LOOKUP = {
  Prefiled: 717170005,
  Filed: 717170000,
  'In Public Review': 717170001,
  Completed: 717170002,
  Unknown: null,
};
const PROJECT_VISIBILITY_LOOKUP = {
  'Applicant Only': 717170002,
  'CPC Only': 717170001,
  'General Public': 717170003,
  'Internal DCP Only': 717170000,
  'LUP': 717170004,
};
const DISPLAY_MILESTONE_IDS = [
  '963beec4-dad0-e711-8116-1458d04e2fb8',
  '943beec4-dad0-e711-8116-1458d04e2fb8',
  '763beec4-dad0-e711-8116-1458d04e2fb8',
  'a63beec4-dad0-e711-8116-1458d04e2fb8',
  '923beec4-dad0-e711-8116-1458d04e2fb8',
  '9e3beec4-dad0-e711-8116-1458d04e2fb8',
  'a43beec4-dad0-e711-8116-1458d04e2fb8',
  '863beec4-dad0-e711-8116-1458d04e2fb8',
  '7c3beec4-dad0-e711-8116-1458d04e2fb8',
  '7e3beec4-dad0-e711-8116-1458d04e2fb8',
  '883beec4-dad0-e711-8116-1458d04e2fb8',
  '783beec4-dad0-e711-8116-1458d04e2fb8',
  'aa3beec4-dad0-e711-8116-1458d04e2fb8',
  '823beec4-dad0-e711-8116-1458d04e2fb8',
  '663beec4-dad0-e711-8116-1458d04e2fb8',
  '6a3beec4-dad0-e711-8116-1458d04e2fb8',
  'a83beec4-dad0-e711-8116-1458d04e2fb8',
  '843beec4-dad0-e711-8116-1458d04e2fb8',
  '8e3beec4-dad0-e711-8116-1458d04e2fb8',
  '780593bb-ecc2-e811-8156-1458d04d0698',

  // these are study area entities and
  // TODO: need to also check for study
  // area flag
  '483beec4-dad0-e711-8116-1458d04e2fb8',
  '4a3beec4-dad0-e711-8116-1458d04e2fb8',
];

// Only these fields will be value mapped
const FIELD_LABEL_REPLACEMENT_WHITELIST = [
  'dcp_publicstatus',
  'dcp_borough',
  'statuscode',
  'dcp_ulurp_nonulurp',
  '_dcp_keyword_value',
  'dcp_ceqrtype',
  'dcp_applicantrole',
  '_dcp_applicant_customer_value',
  '_dcp_recommendationsubmittedby_value',
  'dcp_communityboardrecommendation',
  'dcp_boroughpresidentrecommendation',
  'dcp_boroughboardrecommendation',
  'dcp_representing',
  '_dcp_milestone_value',
  '_dcp_applicant_customer_value',
  '_dcp_applicantadministrator_customer_value',
  '_dcp_action_value',
  '_dcp_zoningresolution_value',
];

function extractMeta(projects = []) {
  const [{ total_projects: total = 0 } = {}] = projects;
  const { length: pageTotal = 0 } = projects;

  return { total, pageTotal };
}

function coerceToNumber(numericStrings) {
  return numericStrings.map(stringish => {
    // smelly; but let's prefer actual null
    // coercing 'null' turns to 0, which we don't
    // want in the API query
    if (stringish === null) return stringish;

    return Number(stringish);
  });
}

function coerceToDateString(epoch) {
  const date = new Date(epoch * 1000);
  console.log(date);

  return date;
}

function mapInLookup(arrayOfStrings, lookupHash) {
  return arrayOfStrings.map(string => lookupHash[string]);
}

function all(...statements): string {
  return statements
    .filter(Boolean)
    .join(' and ');
}

function any(...statements): string {
  return `(${(statements.join(' or '))})`;
}

function comparisonOperator(propertyName, operator, value) {
  let typeSafeValue = value

  if ((typeof value === 'string') && value !== 'false' && value !== 'true') {
    typeSafeValue = `'${value}'`;
  }

  // most likely means it's a date. we want the date formatting that
  // json stringify provides.
  if ((typeof value === 'object') && value !== 'false' && value !== 'true') {
    const stringyDate = JSON.stringify(value).replace(/"/g, "'");

    typeSafeValue = `${stringyDate}`;
  }

  return `(${propertyName} ${operator} ${typeSafeValue})`;
}

function containsString(propertyName, string) {
  return `contains(${propertyName}, '${string}')`;
}

function equalsAnyOf(propertyName, strings = []) {
  const querySegment = strings
    .map(string => comparisonOperator(propertyName, 'eq', string))
    .join(' or ');

  return `(${querySegment})`;
}

function containsAnyOf(propertyName, strings = [], options?) {
  const {
    childEntity = '',
    comparisonStrategy = containsString,
    not = false,
  } = options || {};

  const containsQuery = strings
    .map((string, i) => {
      // in odata syntax, this character o is a variable for scoping
      // logic for related entities. it needs to only appear once.
      const lambdaScope = (childEntity && i === 0) ? `${childEntity}:` : '';
      const lambdaScopedProperty = childEntity ? `${childEntity}/${propertyName}` : propertyName;

      return `${lambdaScope}${comparisonStrategy(lambdaScopedProperty, string)}`;
    })
    .join(' or ');
  const lambdaQueryPrefix = childEntity ? `${childEntity}/any` : '';

  return `(${not ? 'not ': ''}${lambdaQueryPrefix}(${containsQuery}))`;
}

// configure received params, provide procedures for generating queries.
// these funcs do not get called unless they are in the query params.
// could these become a first class object?
const QUERY_TEMPLATES = {
  'community-districts': (queryParamValue) =>
    containsAnyOf('dcp_communitydistricts', queryParamValue),

  'action-types': (queryParamValue) =>
    containsAnyOf('dcp_name', queryParamValue, {
      childEntity: 'dcp_dcp_project_dcp_projectaction_project' 
    }),

  boroughs: (queryParamValue) =>
    equalsAnyOf('dcp_borough', coerceToNumber(mapInLookup(queryParamValue, BOROUGH_LOOKUP))),

  dcp_ulurp_nonulurp: (queryParamValue) =>
    equalsAnyOf('dcp_ulurp_nonulurp', coerceToNumber(mapInLookup(queryParamValue, ULURP_LOOKUP))),

  dcp_femafloodzonev: (queryParamValue) =>
    comparisonOperator('dcp_femafloodzonev', 'eq', queryParamValue),

  dcp_femafloodzonecoastala: (queryParamValue) =>
    comparisonOperator('dcp_femafloodzonecoastala', 'eq', queryParamValue),

  dcp_femafloodzonea: (queryParamValue) =>
    comparisonOperator('dcp_femafloodzonea', 'eq', queryParamValue),

  dcp_femafloodzoneshadedx: (queryParamValue) =>
    comparisonOperator('dcp_femafloodzoneshadedx', 'eq', queryParamValue),

  dcp_publicstatus: (queryParamValue) =>
    equalsAnyOf('dcp_publicstatus', coerceToNumber(mapInLookup(queryParamValue, PROJECT_STATUS_LOOKUP))),

  dcp_certifiedreferred: (queryParamValue) =>
    all(
      comparisonOperator('dcp_certifiedreferred', 'gt', coerceToDateString(queryParamValue[0])),
      comparisonOperator('dcp_certifiedreferred', 'lt', coerceToDateString(queryParamValue[1])),
    ),

  project_applicant_text: (queryParamValue) =>
    any(
      containsString('dcp_projectbrief', queryParamValue),
      containsString('dcp_projectname', queryParamValue),
      containsString('dcp_ceqrnumber', queryParamValue),
      containsAnyOf('dcp_name', [queryParamValue], {
        childEntity: 'dcp_dcp_project_dcp_projectapplicant_Project' 
      }),
      containsAnyOf('dcp_ulurpnumber', [queryParamValue], {
        childEntity: 'dcp_dcp_project_dcp_projectaction_project' 
      }),

      // this is prohibitively slow... not sure we can use this.
      // for some reason, only dcp_name is reasonably query-able in terms of speed.
      containsAnyOf('dcp_name', [queryParamValue], {
        childEntity: 'dcp_dcp_project_dcp_projectbbl_project' 
      }),
    ),
};

function generateProjectsFilterString(query) {
  const ALLOWED_FILTERS = [
    'community-districts',
    'action-types',
    'boroughs',
    'dcp_ceqrtype', // is this even used? 'Type I', 'Type II', 'Unlisted', 'Unknown'
    'dcp_ulurp_nonulurp', // 'ULURP', 'Non-ULURP'
    'dcp_femafloodzonev',
    'dcp_femafloodzonecoastala',
    'dcp_femafloodzonea',
    'dcp_femafloodzoneshadedx',
    'dcp_publicstatus', // 'Prefiled', 'Filed', 'In Public Review', 'Completed', 'Unknown'
    'dcp_certifiedreferred',
    'project_applicant_text',
    'block', // not sure this gets used

    // not implemented yet
    'distance_from_point',
    'radius_from_point'
  ];

  // optional params
  // apply only those that appear in the query object
  const requestedFiltersQuery = Object.keys(query)
    .filter(key => ALLOWED_FILTERS.includes(key)) // filter is allowed
    .filter(key => QUERY_TEMPLATES[key]) // filter has query handler
    .map(key => QUERY_TEMPLATES[key](query[key]));

  return all(
    // defaults
    comparisonOperator('dcp_visibility', 'eq', PROJECT_VISIBILITY_LOOKUP['General Public']),

    // optional params
    ...requestedFiltersQuery,
  );
}

function generateQueryObject(query, overrides?) {
  const DEFAULT_PROJECT_LIST_FIELDS = [
    'dcp_name',
    'dcp_applicanttype',
    'dcp_borough',
    'dcp_ceqrnumber',
    'dcp_ceqrtype',
    'dcp_certifiedreferred',
    'dcp_femafloodzonea',
    'dcp_femafloodzonecoastala', 
    'dcp_femafloodzoneshadedx',
    'dcp_femafloodzonev',
    'dcp_sisubdivision',
    'dcp_sischoolseat', 
    'dcp_projectbrief',
    'dcp_projectname',
    'dcp_publicstatus',
    'dcp_projectcompleted', 
    'dcp_hiddenprojectmetrictarget',
    'dcp_ulurp_nonulurp',
    'dcp_communitydistrict', 
    'dcp_communitydistricts',
    'dcp_validatedcommunitydistricts',
    'dcp_bsanumber',
    'dcp_wrpnumber',
    'dcp_lpcnumber',
    'dcp_name',
    'dcp_nydospermitnumber',
    'dcp_lastmilestonedate',
    '_dcp_applicant_customer_value',
    '_dcp_applicantadministrator_customer_value',
  ];

  // this needs to be configurable, maybe come from project entity
  const projectFields = DEFAULT_PROJECT_LIST_FIELDS.join(',');

  return {
    $select: projectFields,
    $count: true,
    $orderby: 'dcp_lastmilestonedate desc,dcp_publicstatus asc',
    $filter: generateProjectsFilterString(query),
    ...overrides,
  };
}

@Injectable()
export class ProjectService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    private readonly dynamicsWebApi: OdataService,
    private readonly config: ConfigService,
    private readonly tiles: TilesService,
  ) {}

  async findOneByName(name: string): Promise<Project> {
    const DEFAULT_PROJECT_SHOW_FIELDS = [
      'dcp_name',
      'dcp_applicanttype',
      'dcp_borough',
      'dcp_ceqrnumber',
      'dcp_ceqrtype',
      'dcp_certifiedreferred',
      'dcp_femafloodzonea',
      'dcp_femafloodzonecoastala', 
      'dcp_femafloodzoneshadedx',
      'dcp_femafloodzonev',
      'dcp_sisubdivision',
      'dcp_sischoolseat', 
      'dcp_projectbrief',
      'dcp_projectname',
      'dcp_publicstatus',
      'dcp_projectcompleted', 
      'dcp_hiddenprojectmetrictarget',
      'dcp_ulurp_nonulurp',
      'dcp_communitydistrict', 
      'dcp_communitydistricts',
      'dcp_validatedcommunitydistricts',
      'dcp_bsanumber',
      'dcp_wrpnumber',
      'dcp_lpcnumber',
      'dcp_name',
      'dcp_nydospermitnumber',
      'dcp_lastmilestonedate',
      '_dcp_applicant_customer_value',
      '_dcp_applicantadministrator_customer_value',
    ];
    const MILESTONES_FILTER = all(
      `(not ${comparisonOperator('statuscode', 'eq', 717170001)})`,
      containsAnyOf('_dcp_milestone_value', DISPLAY_MILESTONE_IDS, {
        comparisonStrategy: (prop, val) => comparisonOperator(prop, 'eq', val),
      }),
    );
    const ACTIONS_FILTER = `(not ${comparisonOperator('statuscode', 'eq', 717170003)})`;

    // WARNING: Only 5 expansions are allowed by Web API. Requesting more expansions
    // results in a silent failure.
    const EXPANSIONS = [
      `dcp_dcp_project_dcp_projectmilestone_project($filter=${MILESTONES_FILTER};$select=dcp_milestone,dcp_name,dcp_plannedstartdate,dcp_plannedcompletiondate,dcp_actualstartdate,dcp_actualenddate,statuscode,dcp_milestonesequence,dcp_remainingplanneddayscalculated,dcp_remainingplanneddays,dcp_goalduration,dcp_actualdurationasoftoday,_dcp_milestone_value,_dcp_milestoneoutcome_value)`,
      'dcp_dcp_project_dcp_communityboarddisposition_project($select=dcp_publichearinglocation,dcp_dateofpublichearing,dcp_boroughpresidentrecommendation,dcp_boroughboardrecommendation,dcp_communityboardrecommendation,dcp_consideration,dcp_votelocation,dcp_datereceived,dcp_dateofvote,statecode,statuscode,dcp_docketdescription,dcp_votinginfavorrecommendation,dcp_votingagainstrecommendation,dcp_votingabstainingonrecommendation,dcp_totalmembersappointedtotheboard,dcp_wasaquorumpresent,_dcp_recommendationsubmittedby_value,dcp_representing,_dcp_projectaction_value)',
      `dcp_dcp_project_dcp_projectaction_project($filter=${ACTIONS_FILTER};$select=_dcp_action_value,dcp_name,statuscode,statecode,dcp_ulurpnumber,_dcp_zoningresolution_value,dcp_ccresolutionnumber)`,
      'dcp_dcp_project_dcp_projectbbl_project($select=dcp_bblnumber)', // TODO: add filter to exclude inactives
      'dcp_dcp_project_dcp_projectkeywords_project($select=dcp_name,_dcp_keyword_value)',

      // TODO: i think there is a limit of 5 expansions so this one does not even appear
      'dcp_dcp_project_dcp_projectaddress_project($select=dcp_name)',
    ];
    const { records: projects } = await this.dynamicsWebApi
      .queryFromObject('dcp_projects', {
        $select: DEFAULT_PROJECT_SHOW_FIELDS,
        $filter: all(
          comparisonOperator('dcp_name', 'eq', name),
          comparisonOperator('dcp_visibility', 'eq', 717170003),
        ),
        $expand: EXPANSIONS.join(','),
      }, 1);
    const [firstProject] = projects;

    // this must happen before value-mapping because some of the constants
    // refer to certain identifiers that are replaced after value-mapping
    firstProject.milestones = transformMilestones(firstProject.dcp_dcp_project_dcp_projectmilestone_project, firstProject);
    firstProject.dispositions = firstProject.dcp_dcp_project_dcp_communityboarddisposition_project;
    firstProject.video_links = await getVideoLinks(this.config.get('AIRTABLE_API_KEY'), firstProject.dcp_name);

    const [valueMappedFirstProject] = overwriteCodesWithLabels([firstProject], FIELD_LABEL_REPLACEMENT_WHITELIST);

    firstProject.actions = transformActions(firstProject.dcp_dcp_project_dcp_projectaction_project);

    // perform after value-mapping
    firstProject.keywords = valueMappedFirstProject.dcp_dcp_project_dcp_projectkeywords_project
      .map(({ _dcp_keyword_value }) => _dcp_keyword_value);

    firstProject.bbls = valueMappedFirstProject.dcp_dcp_project_dcp_projectbbl_project
      .map(({ dcp_bblnumber }) => dcp_bblnumber);

    firstProject.applicantteam = [{
        name: valueMappedFirstProject._dcp_applicant_customer_value,
        role: 'Primary Applicant',
      }, {
        name: valueMappedFirstProject._dcp_applicantadministrator_customer_value,
        role: 'Primary Contact',
      }];

    // TODO: This could possibly be a carto lookup based on 
    // projectbbl
    // project.bbl_featurecollection = {
    //   type: 'FeatureCollection',
    //   features: [{
    //     type: 'Feature',
    //     geometry: JSON.parse(project.bbl_multipolygon),
    //   }],
    // };

    await injectSupportDocumentURLs(valueMappedFirstProject);

    return this.serialize(valueMappedFirstProject);
  }

  async queryProjects(query, itemsPerPage = ITEMS_PER_PAGE) {
    const queryObject = generateQueryObject(query);

    // EXTRACT META PARAM VALUES;
    const {
      // meta: pagination
      skipTokenParams = '',
    } = query;

    // Note: we can't use PROJECT_KEYS yet because they reference the materialized view
    const {
      records: projects,
      skipTokenParams: nextPageSkipTokenParams,
      count,
    } = await (async () => {
      // prefer the skip token which include original params
      if (skipTokenParams) {
        return this.dynamicsWebApi
          .query('dcp_projects', skipTokenParams, itemsPerPage);
      } else {
        return this.dynamicsWebApi
          .queryFromObject('dcp_projects', queryObject, itemsPerPage);
      } 
    })();

    const valueMappedRecords = overwriteCodesWithLabels(projects, FIELD_LABEL_REPLACEMENT_WHITELIST);
    const transformedProjects = transformProjects(valueMappedRecords);

    return this.serialize(transformedProjects, {
      pageTotal: ITEMS_PER_PAGE,
      total: count,
      ...(nextPageSkipTokenParams ? { skipTokenParams: nextPageSkipTokenParams } : {}),
    });
  }

  async handleDownload(request, filetype) {
    const SQL = buildProjectsSQL(request, 'csv_download');
    const { data } = await this.queryProjects(request, 5000);

    const deserializedData = data
      .map(jsonApiRecord => ({ id: jsonApiRecord.id, ...jsonApiRecord.attributes }));

    return handleDownload(filetype, deserializedData);
  }

  // triggers an update to the normalized_projects view
  async refreshMaterializedView() {
    this.projectRepository.query('REFRESH MATERIALIZED VIEW normalized_projects;');
  }

  // Serializes an array of objects into a JSON:API document
  serialize(records, opts?: object): Serializer {
    const ProjectSerializer = new Serializer('projects', {
      id: 'dcp_name',
      attributes: PROJECT_KEYS,
      actions: {
        ref: 'dcp_projectactionid',
        attributes: ACTION_KEYS,
      },

      milestones: {
        ref: 'dcp_projectmilestoneid',
        attributes: MILESTONE_KEYS,
      },

      dispositions: {
        ref: 'dcp_communityboarddispositionid',
        attributes: DISPOSITION_KEYS,
      },

      // dasherize, but also remove the dash prefix
      // because this confuses the ember client
      keyForAttribute(key) {
        let dasherized = dasherize(key);

        if (dasherized[0] === '-') {
          dasherized = dasherized.substring(1);
        }

        return dasherized;
      },

      meta: { ...opts },
    });

    return ProjectSerializer.serialize(records);
  }

  // A function for creating an issue on github based on user feedback sent from frontend `modal-controls` component
  // Users submit text on the modal stating where they think data is incorrect, which is posted to the backend.
  // Octokit creates an issue in our dcp-zap-data-feedback repository.
  // This function is run in an @Post in the project controller.
  async sendFeedbackToGithubIssue(projectid, projectname, text) {
    const octokit = new Octokit({
      auth: this.config.get('GITHUB_ACCESS_TOKEN'),
    });

    return await octokit.issues.create({
      owner: 'nycplanning',
      repo: 'dcp-zap-data-feedback',
      title: `Feedback about ${projectname}`,
      body: `Project ID: [${projectid}](https://zap.planning.nyc.gov/projects/${projectid})\nFeedback: ${text}`,
    });
  }
}
