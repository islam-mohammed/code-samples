import { Directive, EventEmitter, Input, Output } from '@angular/core';
import { Store } from '@ngrx/store';
import { BaseComponent } from '@pnp/features/shared/ui/base/base-component';
import { FormState } from '../../../state/form.state';

/**
 * Breadcrumb abstraction.
 * This should be extended in web and mobile with platform specific templates
 */
@Directive()
export abstract class BreadcrumbBaseComponent extends BaseComponent {
  @Input()
  crumbs: Array<FormState.IPageCrumb>;
  @Output()
  goTo: EventEmitter<any> = new EventEmitter();

  protected constructor(public store: Store<any>) {
    super();
  }

  select(crumb: FormState.IPageCrumb, index: number) {
    this.goTo.emit({
      crumb,
      index
    });
  }
}
