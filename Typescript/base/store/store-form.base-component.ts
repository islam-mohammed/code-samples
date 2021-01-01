import { SocialLoginService } from './../../../../shared/services/social-login.service';
import { cloneDeep, forEach } from 'lodash-es';
import { TokenString } from './../../../../../../src/app/xplat/core/services/token-string';
import { OnDestroy, OnInit, Directive } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { select, Store } from '@ngrx/store';
import { BaseQuestionType, PersonalizableItem, UserRecipient } from '@pnp/api';
import { PnpLocale } from '@pnp/features/shared/models';
import {
  FileService,
  StorageKeys,
  UserRecipientsService,
  UserService,
  WindowService
} from '@pnp/features/shared/services';
import { BaseComponent } from '@pnp/features/shared/ui';
import { UIState } from '@pnp/features/ui/state/ui.state';
import { PersoItemActions, UserActions, UserState } from '@pnp/features/user';
import { flatten, isFallbackImage, LocaleFormErrorKeys } from '@pnp/utils';
import { combineLatest, Subject, Subscription } from 'rxjs';
import { filter, map, switchMap, take, takeUntil } from 'rxjs/operators';
import { FormService } from '../../../services';
import { FormActions, FormState } from '../../../state';
import { IFieldConfig, IValidationMessage } from '../../models/field.model';
import { User } from '@pnp/sdk';
import { AuthenticationComponent } from 'src/app/xplat/features/auth/modals/authentication.component';
import { ModalActions } from '../../../../ui/state/modal.action';
import { CatalogActions, CatalogState } from '../../../../catalog';
import { Card } from '@pnp/sdk';
import { TrialUpsellModalComponent } from '../../../../../../src/app/xplat/features/ui/components/modals/trial-upsell-modal/trial-upsell-modal.component';

export type TUserRecipient = 'userRecipient';
export type TInputElements = 'inputElements';

export interface IFormSectionTypes {
  userRecipient: TUserRecipient;
  inputElements: TInputElements;
}

export type TActiveSection = TUserRecipient | TInputElements;

export interface IFormSection {
  active?: TActiveSection;
  page?: FormState.IPage;
}

export const recipientFormKeys = ['toFirstName', 'toFirstNameId'];
export const recipientFormDataKeys = ['gender', 'pictureMain', 'country', 'location'];

/**
 * Store Form abstraction.
 */
@Directive()
export abstract class StoreFormBaseComponent extends BaseComponent implements OnInit, OnDestroy {
  /**
   * Form component setup
   * IMPORTANT: implementors must have a @ViewChild setup for `form` property
   * web example: @ViewChild(WebDynamicFormComponent, {static: false}) form: WebDynamicFormComponent;
   */

  form: any;
  user: User.AsObject;
  title: string;
  scenarioTitle: string;
  crumbs: Array<FormState.IPageCrumb> = [];
  activeConfig: FormState.IFormConfig;
  formSectionTypes: IFormSectionTypes = {
    userRecipient: 'userRecipient',
    inputElements: 'inputElements'
  };
  formSection: IFormSection = {};
  fieldsLeft: IFieldConfig[];
  fieldsRight: IFieldConfig[];
  formControlSets: {
    [pageIndex: number]: any;
  } = {};
  recipients: UserRecipient[];
  editItemId: number;
  readyToEdit$: Subject<boolean> = new Subject();
  acceptTerms = false;
  termsConsentPhrase: string;
  scenarioCode: string;
  previousButtonLbl: string;
  nextButtonLbl: string;
  videoTrialExpired = false;

  protected selectedRecipient: UserRecipient;
  private _readyToEditFired = false;
  private _scenarioId: number;
  private _recipientJustSelected = false;

  private _scenarioDataSub: Subscription;
  private submitOnLoginSuccess = false;

  enableCreate = true;

  private _currentPage = 0;
  get currentPage() {
    return this._currentPage;
  }

  usedRecipientList = false;

  protected constructor(
    protected store: Store<any>,
    protected win: WindowService,
    protected route: ActivatedRoute,
    public formService: FormService,
    protected userService: UserService,
    private recipientService: UserRecipientsService,
    private fileService: FileService,
    private socialService: SocialLoginService
  ) {
    super();
  }

  ngOnInit() {
    if (!this.activeConfig) {
      this.activeConfig = this.route.snapshot.data.activeConfig;
    }

    this.formService.confirmFormExit = this._confirmFormExit.bind(this);
    this._initTitle();
    this._initRouteParams();
    this._initRecipients();
    this._initUser();

    // setup crumbs
    if (this.activeConfig.pages?.length) {
      this.crumbs = this.activeConfig.pages.map((p: any) => {
        return {
          completed: false,
          icon: p.icon,
          isSelectable: true,
          name: p.label,
          selected: false,
          isPremium: false
        };
      });

      this._activatePage(this.editItemId != null);
    }

    const data = JSON.parse(localStorage.getItem(StorageKeys.FORM_DATA));
    if (data && this.socialService.isFacebookInBrowserApp()) {
      localStorage.removeItem(StorageKeys.FORM_DATA);
      this.socialService.socialLoggedin
        .pipe(
          switchMap(_ =>
            this.store.pipe(
              select(UserState.selectCurrent),
              filter(user => !!user)
            )
          ),
          take(1),
          takeUntil(this.destroy$)
        )
        .subscribe(user => {
          if (user) {
            this.user = user;
            this.continueSubmit(data);
            this.submitOnLoginSuccess = false;
          }
        });
    } else {
      this.store.pipe(select('user'), takeUntil(this.destroy$)).subscribe((state: UserState.IState) => {
        const currentUserId = state.current?.id ? state.current.id : null;
        if (currentUserId && this.submitOnLoginSuccess) {
          this.submit();
          this.submitOnLoginSuccess = false;
        }
      });
    }
  }

  selectRecipient(recipient: UserRecipient) {
    this.formService.isDirty = true;
    this.usedRecipientList = true;
    this._recipientJustSelected = true;
    if (recipient?.id) {
      this.recipientService.getUserRecipientData(recipient.id.toString()).subscribe(recipientData => {
        const dataMap = [];
        recipientData.dataMap.forEach(prop => (dataMap[prop[0]] = prop[1]));
        this.selectedRecipient = {
          ...recipient,
          ...dataMap
        };
        this.finalizeRecipientSelection(this.selectedRecipient);
        window.scroll(0, 0);
      });
    } else {
      this.selectedRecipient = recipient;
      this.finalizeRecipientSelection(recipient);
      window.scroll(0, 0);
    }
  }

  finalizeRecipientSelection(recipient) {
    this.store.dispatch(new FormActions.SelectRecipientAction(recipient));
    this.formSection.active = this.formSectionTypes.inputElements;
    if (!this.editItemId) {
      this._resetControlSetsForRecipient();
      this._registerForm();
    }

    this._trackFormControls();
    if (this.crumbs?.length === 1) {
      // use scenario as title on single step form
      this._updateTitle(this.scenarioTitle);
    } else {
      const step = this._currentPage + 1;
      this._updateTitle(this.scenarioTitle, step);
    }
    // only if editing a form
    if (this.editItemId) {
      this.readyToEdit$.next(true);
    }
  }

  public confirmFormExit(): Promise<any> {
    return this._confirmFormExit();
  }

  public prevPage(): Promise<any> {
    return new Promise(resolve => {
      this._recipientJustSelected = false;

      if (this._currentPage) {
        this.crumbs[this._currentPage].completed = false;
        this.crumbs[this._currentPage].selected = false;
        this._trackFormControls();
        this._currentPage--;
        this.crumbs[this._currentPage].completed = false;
        this.crumbs[this._currentPage].selected = true;
      } else {
        this.usedRecipientList = false;
      }
      if (this._currentPage === 0 && !this.usedRecipientList) {
        this._confirmFormExit().then(
          confirmMsg => {
            resolve(confirmMsg);
          },
          _ => {
            // this is set to "true" so that if they push Cancel and try to push the Back arrow again
            // this confirmation shows up again
            this.usedRecipientList = true;
          }
        );
      } else {
        this._activatePage(this.usedRecipientList);
      }
    });
  }

  nextPage(termsAccepted = false): boolean {
    this._recipientJustSelected = false;
    if (this._isFormValid()) {
      this.crumbs.forEach(crumb => {
        crumb.selected = false;
        crumb.completed = false;
      });

      this._trackFormControls();
      if (this._currentPage < this.activeConfig.pages.length) {
        this._currentPage++;
      }

      if (this._currentPage === this.activeConfig.pages.length) {
        if (!termsAccepted) {
          const termsRequired = TokenString.SIGNUP_TERMS_REQUIRED_LBL;
          this._currentPage--;
          this.win.alert(termsRequired);
          return false;
        }
        this._currentPage--;
        this.crumbs[this._currentPage].selected = true;
        this.submit();
      } else {
        this._activatePage(true);
        return true;
      }
    }
    return false;
  }

  selectPage(e: { crumb: any; index: number }) {
    for (const crumb of this.crumbs) {
      crumb.selected = false;
    }

    this._currentPage = e.index;

    /*
      Temporary workaround for race condition preventing this.form from being refreshed on ngOnChanges early enough to be picked-up (dynamic-form.base-component.ts)
      The formControls are updated with the form of the previous tab instead of the current tab.
    */
    setTimeout(() => this._trackFormControls(), 350);

    // adjust complete up to currentPage
    for (let i = 0; i < this._currentPage; i++) {
      this.crumbs[i].selected = false;
    }
    // always ignore recipient listing choice when navigating via breadcrumbs
    this._activatePage(true);
  }

  getRawFormGroup(): FormGroup {
    if (this.form?.form) {
      return this.form.form;
    }
    return null;
  }

  ngOnDestroy(): void {
    // reset
    this.formService.reset();
    super.ngOnDestroy();
  }

  submitAction(persoItem): void {
    if (this.formService.isSingleTokenFlow) {
      this.formService.showSingleTokenConfirm$.next(true);
      this.formService.singleTokenConfirm$
        .pipe(takeUntil(this.formService.singleTokenCanceled$))
        .subscribe(confirmed => {
          this.enableCreate = false;
          if (confirmed) {
            this.formService.isSingleTokenFlow = false; // reset
            this.store.dispatch(new PersoItemActions.CreateAction(persoItem));
            this.formService.singleTokenCanceled();
          }
        });
    } else {
      // disable the create button
      this.enableCreate = false;
      this.store.dispatch(new PersoItemActions.CreateAction(persoItem));
    }
  }

  submit() {
    if (this.userService.isAuthenticated()) {
      this.prepareSubmit().then(data => {
        this.continueSubmit(data);
      });
    } else {
      this.submitOnLoginSuccess = true;
      this.store.dispatch(
        new ModalActions.OpenAction({
          cmpType: AuthenticationComponent,
          props: {
            trackTitle: 'Authentication',
            componentContext: 'DEFAULT',
            closable: true,
            email: ''
          },
          modalOptions: {
            backdrop: 'static',
            keyboard: true
          }
        })
      );
    }
  }

  prepareSubmit() {
    return new Promise(resolveAndSubmit => {
      const data: any = {};
      forEach(this.formControlSets, controlSet => {
        forEach(controlSet, (control, key) => {
          data[key] = control.value;
        });
      });

      // Upload images
      const imageUploads = [];
      forEach(data, (field, fieldName) => {
        if (typeof field === 'string' && field?.startsWith('data:image')) {
          imageUploads.push(
            new Promise(resolve =>
              this.fileService.uploadImage(field).subscribe(image => {
                if (image?.file?.path) {
                  resolve({
                    fieldName,
                    url: image.file.path
                  });
                }
              })
            )
          );
        }
      });
      // Replace base64 by actual S3 URLs
      Promise.all(imageUploads).then(results => {
        results.forEach(field => {
          data[field.fieldName] = field.url;
        });
        resolveAndSubmit(data);
      });
    });
  }

  // Remove field data for which the predecessor value nullifies them
  cleanupData(data) {
    const inputDependentValidations = [];
    this.activeConfig.pages.forEach((page, pageIndex) => {
      page.fieldBlocks.forEach(block => {
        block.validationsList.forEach(validation => {
          if (validation.consequentInput && validation.antecedentInput && validation.antecedentValuesList?.length) {
            inputDependentValidations[validation.consequentInput] = {
              pageIndex,
              antecedentInput: {
                name: validation.antecedentInput,
                currentValue: data[validation.antecedentInput]
              },
              expectedAntecedantValues: validation.antecedentValuesList
            };
          }
        });
      });
    });

    // Check if a field value should be removed because an antecedant field value is not matched anymore
    forEach(data, (fieldValue, fieldName) => {
      const depField = inputDependentValidations[fieldName];
      if (depField && !depField.expectedAntecedantValues.includes(depField.antecedentInput.currentValue)) {
        data[fieldName] = null;
      }
    });

    return data;
  }

  uploadRecipientImages(recipient) {
    return new Promise((resolve, reject) => {
      const imageUploads = [];
      forEach(recipient.data, (field, fieldName) => {
        if (typeof field === 'string' && field?.startsWith('data:image')) {
          imageUploads.push(
            new Promise(res =>
              this.fileService.uploadImage(field).subscribe(image => {
                if (image?.file?.path) {
                  res({
                    fieldName,
                    url: image.file.path
                  });
                }
              })
            )
          );
        }
      });
      // Replace base64 by actual S3 URLs
      Promise.all(imageUploads).then(results => {
        results.forEach(field => {
          recipient.data[field.fieldName] = field.url;
        });
        resolve(recipient);
      });
    });
  }

  checkIfVideoTrialExpired(data) {
    this.store
      .select(CatalogState.selectCatalogFolders)
      .pipe(
        filter(folders => !!folders.video),
        map(folders => {
          return folders.video;
        }),
        take(1)
      )
      .subscribe(videoFolder => {
        let freeTrialExpiredForVideo = false;
        videoFolder.groupsList.forEach(group =>
          group.cardsList.forEach(card => {
            if (
              card.cardAction === Card.Action.TRIAL_UPSELL &&
              card.video.scenarioId === (this.activeConfig as any).scenarioId &&
              card.video.formId === (this.activeConfig as any).formId
            ) {
              freeTrialExpiredForVideo = true;
            }
          })
        );

        if (!freeTrialExpiredForVideo) {
          this.finalizeSubmit(data);
        } else {
          this.store.dispatch(
            new ModalActions.OpenAction({
              cmpType: TrialUpsellModalComponent,
              props: {
                trackTitle: 'Modal Trial Upsell Open'
              }
            })
          );
        }
      });
    this.store.dispatch(
      new CatalogActions.FetchFolderAction({
        folderId: 'video'
      })
    );
  }

  continueSubmit(data) {
    if (this.formService.formType === 'video') {
      this.checkIfVideoTrialExpired(data);
    } else {
      this.finalizeSubmit(data);
    }
  }

  finalizeSubmit(data) {
    if (this.selectedRecipient) {
      const allFormFieldNames = flatten(
        this.activeConfig.pages.map(c => flatten(c.fieldBlocks.map(b => b.fields)).map(f => f.name))
      );

      for (const fieldName of allFormFieldNames) {
        if (!data.hasOwnProperty(fieldName) && this.selectedRecipient[fieldName]) {
          data[fieldName] = this.selectedRecipient[fieldName];
        }
      }
    }

    // Personalizing means accepting the terms
    this.user.termsOfUseAccepted = true;
    this.store.dispatch(
      new UserActions.UpdateAction({
        user: this.user
      })
    );

    this.store.pipe(select(UIState.selectLocale), take(1)).subscribe((locale: PnpLocale) => {
      const persoItem: PersonalizableItem = {};
      persoItem.scenario = {
        id: this._scenarioId
      };
      persoItem.data = this.formatData(data);

      persoItem.culture = locale;
      if (this.selectedRecipient?.id) {
        persoItem.data.userRecipient = this.selectedRecipient.id.toString();
      }

      this.formService.isDirty = false; // ensure this is off (will not be dirty if made it this far)
      this.submitAction(persoItem);
    });
  }

  protected resetRecipient(isRouteChange: boolean) {
    this.formService.isDirty = false;
    this.formService.countryHasNoLocations = false;
    this.selectedRecipient = null;
    this.store.dispatch(new FormActions.SelectRecipientAction(null));
    if (isRouteChange) {
      this.formService.isSingleTokenFlow = false;
    } else {
      this._activatePage(this.usedRecipientList);
    }
  }

  protected formatData(data): any {
    const formattedData: any = {};
    data = this.cleanupData(data);
    if (data.doNotKnowBirthday === '1') {
      data.birthday = null;
    }

    if (data.hasOwnProperty('doNotKnowBirthday') && data.doNotKnowBirthday === '0') {
      // ensure these are nulled out if the 'doNotKnowBirthday' property is set to false
      data.doNotKnowBirthday = null;
      data.age = null;
    }
    for (const key in data) {
      if (data[key] === 'null' || data[key] === 'undefined') {
        // clean out erroneous 'null' or 'undefined' string which may come from web/dom select fields
        formattedData[key] = null;
      } else if (typeof data[key] === 'string' && isFallbackImage(data[key])) {
        // ignore all fallback images
      } else {
        formattedData[key] = data[key];
      }
    }
    if (formattedData.toFirstNamePlural) {
      // always ensure toFirstName and toFirstNameId is cleared when using plural names
      delete formattedData.isGroup;
      delete formattedData.toFirstName;
      delete formattedData.toFirstNameId;
    }
    if (formattedData.location && this.formService.countryHasNoLocations) {
      formattedData.location = null;
    }
    if (this.formService.countryHasNoCity) {
      formattedData.city = null;
    }

    return formattedData;
  }

  private _resetScenarioDataHelper() {
    if (this._scenarioDataSub) {
      this._scenarioDataSub.unsubscribe();
      this._scenarioDataSub = null;
    }
  }

  private _checkIfEditable() {
    if (this.editItemId && this.recipients && !this._readyToEditFired) {
      this._readyToEditFired = true;
      this.readyToEdit$.next(true);
    }
  }

  private _updateTitle(title: string, step?: number) {
    const numberOfSteps = this.activeConfig?.pages ? this.activeConfig.pages.length : 4;
    if (numberOfSteps === 2) {
      switch (step) {
        case 1:
          title = TokenString.Form.STEP_1_OF_2;
          break;
        case 2:
          title = TokenString.Form.STEP_2_OF_2;
          break;
      }
      this.title = title;
      return;
    }

    if (numberOfSteps === 3) {
      switch (step) {
        case 1:
          title = TokenString.Form.STEP_1_OF_3;
          break;
        case 2:
          title = TokenString.Form.STEP_2_OF_3;
          break;
        case 3:
          title = TokenString.Form.STEP_3_OF_3;
          break;
      }
      this.title = title;
      return;
    }
    if (numberOfSteps === 4) {
      switch (step) {
        case 1:
          title = TokenString.Form.STEP_1_OF_4;
          break;
        case 2:
          title = TokenString.Form.STEP_2_OF_4;
          break;
        case 3:
          title = TokenString.Form.STEP_3_OF_4;
          break;
        case 4:
          title = TokenString.Form.STEP_4_OF_4;
          break;
      }
      this.title = title;
      return;
    }
  }
  private _activatePage(ignoreRecipientList?: boolean) {
    this.crumbs[this._currentPage].selected = true;
    this.formSection.page = this.activeConfig.pages[this._currentPage];
    this.previousButtonLbl = this.formSection.page.previousButton;
    this.nextButtonLbl = this.formSection.page.nextButton;

    // separate userRecipient type from fields
    if (this.formSection.page) {
      if (!ignoreRecipientList && this.activeConfig.showUserRecipient && !this.usedRecipientList) {
        // ignore recipient list if just beginning to edit a form (should jump straight into form with recipient already selected)
        // choose user recipients
        if (this.recipients?.length) {
          this.formSection.active = this.formSectionTypes.userRecipient;
        } else {
          const formData = JSON.parse(localStorage.getItem(StorageKeys.FORM_DATA));
          if (formData) {
            this.selectRecipient(formData);
          } else {
            this.selectRecipient(null);
          }
        }
        this._updateTitle(this.crumbs[this._currentPage].name);
      } else {
        this._updateTitle(this.crumbs[this._currentPage].name, this.crumbs.length > 1 ? this._currentPage + 1 : -1);
        if (this.activeConfig.showUserRecipient && ignoreRecipientList) {
          // ensure this has been set - need this for editing to be able to return to recipients when in a multiple page form
          // editing form jumps straight into form but should allow user to return to the list
          this.usedRecipientList = true;
        }
        this.formSection.active = this.formSectionTypes.inputElements;
      }
      this._registerFields(this.formSection.page);
    }
  }

  private _registerFields(page: FormState.IPage) {
    // always reset to empty when starting to process fields
    this.fieldsLeft = [];
    this.fieldsRight = [];
    // process each block and parse left or right field configs based on their alignment
    page.fieldBlocks.forEach(fieldBlock => {
      if (fieldBlock.type !== this.formSectionTypes.userRecipient) {
        // ignore userRecipient type blocks since UI is handled with custom recipient list and dynamic form fields are not used for those
        let fields = cloneDeep(fieldBlock.fields);
        if (fields.find(f => f.name === 'phoneCountryId')) {
          const phoneFields = [];
          const phoneCountryId = fields.find(f => f.name === 'phoneCountryId');
          if (phoneCountryId) {
            phoneCountryId.options = [];
            phoneCountryId.type = BaseQuestionType.choice;
            phoneCountryId.placeholder = phoneCountryId.label;
            if (this.selectedRecipient?.data?.phoneCountryId) {
              phoneCountryId.value = this.selectedRecipient.data.phoneCountryId;
            }
            phoneFields.push(phoneCountryId);
          }

          const phoneCountryCode = fields.find(f => f.name === 'phoneCountryCode');
          if (phoneCountryCode) {
            phoneCountryCode.hidden = true;
            phoneCountryCode.options = [];
            phoneCountryCode.type = BaseQuestionType.choice;

            // default to US always
            phoneCountryCode.value = '1';
            if (this.selectedRecipient?.data?.phoneCountryCode) {
              phoneCountryCode.value = this.selectedRecipient.data.phoneCountryCode;
            }
            phoneFields.push(phoneCountryCode);
          }

          const phoneNumber = fields.find(f => f.name === 'phoneNumber');
          if (phoneNumber) {
            // use country code if available, otherwise fallback to US/CA for conveneince
            phoneNumber.prefix = phoneCountryCode.value ? `+${phoneCountryCode.value}` : '+1';
            if (this.selectedRecipient?.data?.phoneNumber) {
              phoneNumber.value = this.selectedRecipient.data.phoneNumber;
            }
            phoneFields.push(phoneNumber);
          }

          fields = phoneFields;
        }

        // always push in immutable objects
        switch (fieldBlock.alignment) {
          case 2:
            this.fieldsRight.push(...fields);
            break;
          default:
            this.fieldsLeft.push(...fields);
        }
      }
    });
    this._registerForm();
  }

  private _confirmFormExit(isRouteChange?: boolean, isChangingLanguage?: boolean) {
    return new Promise(resolve => {
      if (this.formService.isDirty || isChangingLanguage) {
        // confirm with user that they want to exit the form
        resolve(this.formService.localizeConfirmFormExit(isChangingLanguage, isRouteChange));
      } else {
        this.resetRecipient(isRouteChange);
        resolve();
      }
    });
  }

  private _registerForm() {
    const doRegister = () => {
      const rawForm = this.getRawFormGroup();
      const values: any = {};
      const currentSet = this.formControlSets[this._currentPage];
      // tslint:disable-next-line: forin
      for (const key in rawForm.controls) {
        if (currentSet) {
          if (recipientFormKeys.includes(key) && !this.selectedRecipient && this._recipientJustSelected) {
            // only if newly selected new recipient (otherwise fallback to using prior data entry in next condition)
            values[key] = null; // ensure nulled out with no recipient
          } else if (currentSet[key]) {
            // hydrate form value with what user already entered
            const data = currentSet[key];
            values[key] = data.constructor === FormControl ? data.value : data;

            this._adjustOptionSelection(
              this.fieldsLeft.filter(f => this._selectableOptions(f, key)),
              values[key]
            );
            this._adjustOptionSelection(
              this.fieldsRight.filter(f => this._selectableOptions(f, key)),
              values[key]
            );
          }
        }

        if (this.editItemId && key === 'termsOfUse') {
          values[key] = true;
        }
      }

      // Hydrate from recipient
      if (this.selectedRecipient) {
        for (const key in rawForm.controls) {
          if (rawForm.controls.hasOwnProperty(key)) {
            rawForm.controls[key].setValue(this.selectedRecipient[key]);
          }
        }
      }

      if (Object.keys(values).length) {
        for (const key in values) {
          if (key.indexOf('toFirstNameId') > -1 || key.indexOf('Audio') > -1) {
            const custom: any = {};
            custom[key] = values[key];
            this.formService.setCustomPronunciations(custom);
          }
        }

        rawForm.patchValue(values, {
          emitEvent: true
        });
      }
    };

    // Wait for form binding
    setTimeout(() => this.form && doRegister(), 100);
  }

  // after filling out the form but decides to go back and change the recipient
  private _resetControlSetsForRecipient() {
    if (Object.keys(this.formControlSets).length) {
      // formControlSets are used to retain previously entered form data
      if (this.selectedRecipient?.data) {
        // set recipient pictureMain to null if it is not exist
        // to avoid not reseting the pictureMain component when there are
        // no pictureMain in recipient data
        if (!this.selectedRecipient.data.pictureMain) {
          this.selectedRecipient.data.pictureMain = null;
        }
        // when choosing new recipients, if prior data had been set
        // update it to match the latest recipient data
        // tslint:disable-next-line: forin
        for (const pageIndex in this.formControlSets) {
          const currentSet = this.formControlSets[pageIndex];
          if (currentSet) {
            // update direct properties
            const directProps = ['toFirstName', 'birthday'];
            for (const prop of directProps) {
              if (currentSet.hasOwnProperty(prop)) {
                switch (prop) {
                  case 'toFirstName':
                    currentSet[prop].setValue(this.selectedRecipient.name);
                    break;
                  case 'birthday':
                    currentSet[prop].setValue(this.selectedRecipient.birthday);
                    break;
                }
              }
            }
            // now update based on the selectedRecipient.data
            for (const key in this.selectedRecipient.data) {
              if (currentSet[key]) {
                if (recipientFormDataKeys.includes(key)) {
                  // always reset with these specific recipient data properties
                  currentSet[key].setValue(this.selectedRecipient.data[key]);
                } else if (
                  currentSet.hasOwnProperty(key) &&
                  !currentSet[key].value &&
                  this.selectedRecipient.data[key]
                ) {
                  // 1. only if the set has the key
                  // 2. only if the value had not been previously set
                  // 3. only if the recipient has defined data to use as a value
                  currentSet[key].setValue(this.selectedRecipient.data[key]);
                }
              }
            }
          }
        }
      } else {
        // user is choosing new recipient, clear name and pronunciation
        for (const key of ['toFirstName', 'toFirstNameId']) {
          // tslint:disable-next-line: forin
          for (const pageIndex in this.formControlSets) {
            const currentSet = this.formControlSets[pageIndex];
            if (currentSet && currentSet[key]) {
              currentSet[key].setValue(null);
            }
          }
        }
      }
    }
  }

  private _adjustOptionSelection(fieldConfigs: Array<any>, value: any) {
    for (const field of fieldConfigs) {
      for (const option of field.options) {
        if (option.value === value) {
          option.selected = true;
          break;
        }
      }
    }
  }

  private _selectableOptions(f: IFieldConfig, key: string): boolean {
    // selectable options are generally less than 4 (usually image blocks that can be selected)
    // most importantly we just want prevent those using this function from looping
    // through 100's or even 1000's of options since those are not the selection blocks
    return f.name === key && f.options?.length > 0 && f.options.length < 5;
  }

  _trackFormControls(): void {
    const rawForm = this.getRawFormGroup();
    // track FormControl sets from each page
    if (rawForm) {
      // must be cloned/copied
      this.formControlSets[this._currentPage || 0] = Object.assign({}, rawForm.controls);
    }
  }

  private _isFormValid(): boolean {
    const rawForm = this.getRawFormGroup();
    if (rawForm) {
      if (
        this.editItemId &&
        rawForm.controls?.termsOfUse &&
        rawForm.controls.termsOfUse.value &&
        !rawForm.controls.termsOfUse.valid
      ) {
      } else if (rawForm.status === 'INVALID' && !rawForm.valid) {
        this.formService.isDirty = true;
        this._reportFormErrors(rawForm);
        return false;
      }
    }
    return true;
  }

  private _reportFormErrors(form: FormGroup): void {
    let errorMessage = '';
    forEach(form.controls, (control, key) => {
      if (control.errors != null) {
        const errorTypes = Object.keys(control.errors);
        if (errorTypes?.length) {
          forEach(errorTypes, errorType => {
            let field = this.fieldsLeft.find(f => f.name === key);
            if (!field) {
              field = this.fieldsRight.find(f => f.name === key);
            }
            forEach(field.validationMessages, (validationMessage: IValidationMessage) => {
              if (validationMessage.type.toLowerCase() === errorType.toLowerCase()) {
                let msg = validationMessage.message;
                if (msg) {
                  if (msg[msg.length - 1] !== '.') {
                    msg += '. ';
                  }
                  if (msg?.length) {
                    if (msg[msg.length - 1] !== ' ') {
                      msg = `${msg} `;
                    }
                  }
                  errorMessage += msg;
                } else {
                  this._defaultErrorMessage(form, errorMessage, key, errorType);
                }
              }
            });
            if (!errorMessage) {
              this._defaultErrorMessage(form, errorMessage, key, errorType);
            }
            if (!field.validationMessages.length) {
              this._defaultErrorMessage(form, errorMessage, key, errorType);
            }
          });
        }
      }
    });
    if (errorMessage) {
      this.win.alert(errorMessage);
    }
  }

  private _defaultErrorMessage(form: FormGroup, errorMessage: string, key: string, errorType: string) {
    errorMessage += `${LocaleFormErrorKeys.field} '${key}' ${LocaleFormErrorKeys.contains}: '${errorType}'. ${LocaleFormErrorKeys.value}: '${form.controls[key].value}'. `;
  }

  private _initUser() {
    this.store.pipe(select(UserState.selectCurrent)).subscribe(user => {
      this.user = user;
    });
  }

  private _initRouteParams() {
    const qParams = this.route.snapshot.queryParams;
    this._scenarioId = (this.activeConfig as any).scenarioId;
    this.scenarioTitle = qParams.title || '';

    // PersoitemID
    if (this.route.snapshot.queryParams.pid) {
      this._initPage(qParams.pid);
    }
  }

  private _initPage(itemId?: any) {
    if (itemId) {
      this.editItemId = itemId;
      this._checkIfEditable();
    }
    this._resetScenarioDataHelper();
  }

  private _initTitle() {
    this.route.url.pipe(takeUntil(this.destroy$)).subscribe(urlSegments => {
      let formType;
      if (this.formService.editPersoIds) {
        formType = this.formService.editPersoIds.type;
      } else if (urlSegments?.length) {
        const segment = urlSegments[0];
        formType = segment.path;
      }
      this.formService.formType = formType;

      const title = formType === 'video' ? TokenString.VideoStore.CREATE_VIDEO_TLE : TokenString.CREATE_CALL_TLE;

      this._updateTitle(title);
    });
  }

  private _initRecipients() {
    const recipients$ = this.store.pipe(select(UserState.selectRecipients));
    const activeConfig$ = this.store.pipe(select(FormState.selectLatestActiveConfig));

    combineLatest([activeConfig$, recipients$])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([config, recipients]: [any, UserRecipient[]]) => {
        if (recipients) {
          recipients = recipients;
        }

        if (config && recipients) {
          if (config.params.hasGroupName && config.params.hasToFirstName) {
            this.recipients = recipients;
          } else if (config.params.hasToFirstName) {
            this.recipients = recipients.filter((recipient: any) => recipient.type === 0);
          } else if (config.params.hasGroupName) {
            this.recipients = recipients.filter((recipient: any) => recipient.type === 1);
          }
        }

        this._checkIfEditable();
      });
  }
}
