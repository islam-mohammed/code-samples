import { Directive, Input, OnInit } from '@angular/core';
import { Store } from '@ngrx/store';
import { takeUntil } from 'rxjs/operators';
import { IValidateTargetUpdate } from '../../../services';
import { FormState } from '../../../state';
import { IValidationMessage } from '../../models';
import { FormElementBaseComponent } from '../form-element/form-element.base-component';

/**
 * common form interfaces
 */
export interface ISelectItem {
  name: string;
  value: any;
  isChecked?: boolean;
  isExactMatch?: boolean;
}

export interface ISelectGroup {
  name: string;
  items: ISelectItem[];
}

/**
 * Form select abstraction.
 */
@Directive()
export abstract class FormSelectBaseComponent extends FormElementBaseComponent implements OnInit {
  @Input()
  optionsUpdated: any;
  selectGroups: ISelectGroup[] = [];

  protected constructor(store: Store<FormState.IFeatureState>) {
    super(store);
  }

  ngOnInit() {
    this.adjustGroupOptions();
    if (this.formService.validateTargetUpdate$) {
      this.formService.validateTargetUpdate$
        .pipe(takeUntil(this.destroy$))
        .subscribe((update: IValidateTargetUpdate) => {
          if (update.name === this.config.name) {
            // just update validation message on the field
            const error: IValidationMessage = {
              message: update.errorMessage,
              type: update.type
            };
            if (!this.config.validationMessages || this.config.validationMessages?.length === 0) {
              this.config.validationMessages = [error];
            } else {
              const alreadyExists = this.config.validationMessages.find(v => {
                return v.type === error.type && v.message === error.message;
              });
              if (!alreadyExists) {
                this.config.validationMessages.push(error);
              }
            }
          }
        });
    }
    this.formService.reloadFieldOptions$.pipe(takeUntil(this.destroy$)).subscribe(config => {
      if (this.config?.name === config.name) {
        this.config.options = config.options;
        this.adjustGroupOptions();
      }
    });
  }

  adjustGroupOptions() {
    if (this.config?.options) {
      const options = this.config.options;
      if (options?.length) {
        this.selectGroups = [];
        for (const option of options) {
          let group;
          const subOptions = option.options;
          if (subOptions?.length && option.label) {
            group = this.selectGroups.find(_group => _group.name === option.label);
            if (!group) {
              group = {
                name: option.label,
                items: []
              };
            }
            for (const opt of subOptions) {
              const temp = {
                name: null,
                value: opt.value
              };
              if (opt.label?.length) {
                temp.name = opt.label;
              } else {
                temp.name = `(${opt.value})`;
              }
              group.items.push(temp);
            }
          } else {
            // flat list
            group = {
              name: '', // blank name since category not used with flat list
              items: []
            };
            const temp = {
              name: null,
              value: option.value
            };
            if (option.label?.length) {
              temp.name = option.label;
            } else {
              temp.name = `(${option.value})`;
            }
            group.items.push(temp);
          }
          this.selectGroups.push(group);
        }
      }
    }
  }
}
